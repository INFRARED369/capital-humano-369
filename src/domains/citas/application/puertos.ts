/** Puertos que usan los casos de uso de citas. El adaptador SQL vive en infra/sqlCitasRepo.ts. */
import type { EventoDominio } from '@shared/eventos.ts';
import type { EstadoCita } from '../domain/estados.ts';
import type { FilaReglas } from '../domain/reglas.ts';
import type { CitaActiva } from '../domain/slots.ts';

export interface VacanteAgenda {
  id: string;
  clienteId: string;
  activa: boolean;
  agendaModo: 'sistema' | 'whatsapp';
}

export interface CitaRegistro {
  id: string;
  clienteId: string;
  vacanteId: string;
  /** null si el lead fue suprimido o anonimizado. */
  leadId: string | null;
  inicio: string;
  fin: string;
  estado: EstadoCita;
  reglasVersion: number;
  expiraEn: string | null;
  motivo: string | null;
  /** Momento de la retención (o de la reserva); base del tope de extensión. Opcional por compatibilidad. */
  creadoEn?: string;
}

export interface SolicitudRetencion {
  vacanteId: string;
  leadId: string;
  inicio: string;
  fin: string;
  /** Día local 'YYYY-MM-DD' de la vacante: base del cupo y del lock. */
  dia: string;
  capacidad: number;
  cupo: number;
  empalmes: boolean;
  reglasVersion: number;
  expiraEn: string | null;
  ahora: string;
  estado: 'retenida' | 'confirmada';
  citaAnteriorId?: string;
}

export type ResultadoRetencion =
  | { resultado: 'OK'; citaId: string; expiraEn: string | null }
  | { resultado: 'SLOT_LLENO' | 'CUPO_DIARIO' | 'VACANTE_NO_ENCONTRADA' | 'CITA_ACTIVA' };

export interface CambioEstado {
  estado: EstadoCita;
  ahora: string;
  motivo?: string;
}

export interface CitasRepo {
  /** Por id (UUID) o por slug. */
  buscarVacante(ref: string): Promise<VacanteAgenda | null>;
  /** `config.reglas_vigentes(vacante)`; null si no hay versión guardada. */
  reglasVigentes(vacanteId: string): Promise<FilaReglas | null>;
  expirarRetenciones(ahora: string, vacanteId?: string): Promise<number>;
  /** Citas que ocupan capacidad (confirmadas + retenidas vigentes) con inicio en [desde, hasta). */
  ocupacion(vacanteId: string, desde: string, hasta: string, ahora: string): Promise<CitaActiva[]>;
  /** Reserva atómica con lock por (vacante, día) — `citas.retener`. */
  retener(s: SolicitudRetencion): Promise<ResultadoRetencion>;
  obtener(citaId: string, opciones: { bloquear: boolean }): Promise<CitaRegistro | null>;
  cambiarEstado(citaId: string, cambio: CambioEstado): Promise<void>;
  /** Solo citas retenidas: fija `expira_en` (la extensión por reenvío del OTP). */
  extenderRetencion(citaId: string, expiraEn: string, ahora: string): Promise<void>;
  /** `shared.publicar_evento` en la misma transacción. */
  publicar(evento: EventoDominio, clienteId: string): Promise<void>;
}

/** Datos mínimos del candidato para el evento CitaReprogramada (lo implementa captación). */
export interface ContactosPort {
  datosCita(leadId: string): Promise<{ folio: string; nombrePila: string } | null>;
}
