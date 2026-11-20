/**
 * Puertos del subdominio citas/zoho. La aplicación depende solo de esto;
 * infra/ los implementa (HTTP de Zoho, SQL sobre PGlite/Postgres).
 */
import type { Result } from '@shared/result.ts';
import type { Logger } from '@shared/logger.ts';
import type { Clock } from '@shared/clock.ts';
import type { ConfigEvento, EventoCalendario } from '../domain/evento.ts';
import type { ErrorCalendario, EventoRemoto, TipoAlertaZoho } from '../domain/tipos.ts';

export interface RangoFechas {
  /** ISO UTC */
  desde: string;
  /** ISO UTC */
  hasta: string;
}

/** Calendario externo (Zoho Calendar). Todas las operaciones devuelven Result: nunca lanzan. */
export interface CalendarioExternoPort {
  crear(calendarUid: string, evento: EventoCalendario): Promise<Result<EventoRemoto, ErrorCalendario>>;
  actualizar(calendarUid: string, eventUid: string, etag: string, evento: EventoCalendario): Promise<Result<EventoRemoto, ErrorCalendario>>;
  /** Idempotente: borrar un evento inexistente es éxito. */
  borrar(calendarUid: string, eventUid: string, etag: string): Promise<Result<void, ErrorCalendario>>;
  /** null si no existe. */
  obtener(calendarUid: string, eventUid: string): Promise<Result<EventoRemoto | null, ErrorCalendario>>;
  listar(calendarUid: string, rango: RangoFechas): Promise<Result<EventoRemoto[], ErrorCalendario>>;
}

export type EstadoSync = 'pendiente' | 'sincronizado' | 'error' | 'sin_calendario' | 'borrado' | 'reemplazado';

/** Fila de citas.zoho_eventos: lo que el sistema publicó o debe publicar en Zoho. */
export interface RegistroZoho {
  citaId: string;
  clienteId: string;
  vacanteId: string;
  leadId: string | null;
  zohoCalendarUid: string | null;
  zohoEventUid: string | null;
  uidPropio: string;
  estadoSync: EstadoSync;
  vigente: boolean;
  inicio: string;
  fin: string;
  folio: string;
  nombrePila: string | null;
  intentos: number;
}

export type NuevoRegistro = Omit<RegistroZoho, 'intentos' | 'vigente'>;

export interface ZohoRepo {
  obtener(citaId: string): Promise<RegistroZoho | null>;
  marcarSincronizado(citaId: string, zohoEventUid: string): Promise<void>;
  marcarBorrado(citaId: string): Promise<void>;
  /** Suma un intento y guarda el error; `definitiva` = dead letter (estado 'error'). */
  marcarFalla(citaId: string, mensaje: string, definitiva: boolean): Promise<void>;
  /** Registros vigentes con inicio en [desde, hasta) (reconciliación). */
  vigentesEnRango(rango: RangoFechas): Promise<RegistroZoho[]>;
  /** El sistema gana: corrige horario/vigencia de un registro según la fuente de verdad. */
  corregir(citaId: string, cambios: { inicio?: string; fin?: string; vigente?: boolean; zohoCalendarUid?: string; estadoSync?: EstadoSync }): Promise<void>;
}

export interface AlertaZoho {
  tipo: TipoAlertaZoho;
  clienteId: string;
  vacanteId: string | null;
  citaId: string | null;
  /** Sin PII: ids, campos y motivos. */
  detalle: Record<string, unknown>;
}

export interface AlertasPort {
  registrar(a: AlertaZoho): Promise<void>;
}

export interface TrabajoSync {
  id: string;
  citaId: string;
  /** Intentos ya consumidos, incluido el actual (1-based). */
  intentos: number;
}

/** Cola `zoho-sync` sobre shared.cola. */
export interface ColaSyncPort {
  recuperarVencidos(): Promise<number>;
  tomar(n: number, vtSeg: number): Promise<TrabajoSync[]>;
  completar(id: string): Promise<void>;
  fallar(id: string, mensaje: string, backoffSeg: number): Promise<'reintento' | 'dead_letter'>;
  /** Error permanente: directo a dead letter sin gastar reintentos (shared.fallar_definitivo). */
  fallarDefinitivo(id: string, mensaje: string): Promise<'dead_letter'>;
}

/** Evento leído del outbox (consumidor `zoho-sync`). */
export interface EventoOutbox {
  id: string;
  eventoId: string;
  tipo: string;
  payload: unknown;
}

/** Operaciones de ingesta: se ejecutan en UNA transacción junto con el avance del cursor. */
export interface IngestaTx {
  leer(n: number): Promise<EventoOutbox[]>;
  avanzar(ultimoId: string): Promise<void>;
  /** `zoho_calendar_uid` de las reglas vigentes de la vacante (sin validar). */
  calendarioDe(vacanteId: string): Promise<string | null>;
  obtener(citaId: string): Promise<RegistroZoho | null>;
  /** false si ya existía (entrega duplicada). */
  insertar(r: NuevoRegistro): Promise<boolean>;
  marcar(citaId: string, cambios: { vigente: boolean; estadoSync: EstadoSync; quitarEventUid?: boolean }): Promise<void>;
  encolar(citaId: string, clienteId: string, llave: string): Promise<void>;
  alertar(a: AlertaZoho): Promise<void>;
}

export interface IngestaPort {
  enTransaccion<T>(fn: (tx: IngestaTx) => Promise<T>): Promise<T>;
}

/**
 * Fuente de verdad de las citas vigentes para la reconciliación (CIT-09): citas que DEBEN
 * tener evento en Zoho, con inicio en [desde, hasta). La reconciliación solo mira el futuro
 * (desde = ahora): las citas pasadas (asistió/no asistió) no se tocan; la retención las borra.
 * PRODUCCIÓN: consulta a citas.citas (estado confirmada, inicio en el rango) — la implementa
 * el dominio citas/orquestador. PRUEBAS: se deriva de citas.zoho_eventos o de un fake.
 */
export interface CitaVigente {
  citaId: string;
  inicio: string;
  fin: string;
}
export interface CitasVigentesPort {
  vigentes(rango: RangoFechas): Promise<CitaVigente[]>;
}

export interface DepsSync {
  repo: ZohoRepo;
  calendario: CalendarioExternoPort;
  cfgEvento: ConfigEvento;
  logger: Logger;
}

export interface DepsWorker extends DepsSync {
  cola: ColaSyncPort;
  alertas: AlertasPort;
  ingesta: IngestaPort;
}

export interface DepsReconciliacion extends DepsSync {
  alertas: AlertasPort;
  citasVigentes: CitasVigentesPort;
  /** Re-resuelve el calendario de una vacante (Z7 resuelto después). */
  calendarioDe(vacanteId: string): Promise<string | null>;
  clock: Clock;
}
