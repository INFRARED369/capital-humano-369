/** Puertos del dominio privacidad. Los implementa infra/sql (BD) y captación (contacto del lead). */
import type { Clock } from '@shared/clock.ts';
import type { Logger } from '@shared/logger.ts';
import type { Result } from '@shared/result.ts';
import type { CanalArco, EstadoArco, TipoArco } from '../domain/arco.ts';
import type { Conteos } from '../domain/registro.ts';

export interface ResumenRetencion {
  registroId: number | null;
  omitida: boolean;
  dominios: string[];
  faltantes: string[];
  errores: Record<string, string>;
  lotes: Record<string, number>;
  conteos: Conteos;
  total: number;
}

export interface NuevaSolicitud {
  tipo: TipoArco;
  canal: CanalArco;
  telefonoHmac: string | null;
  leads: string[];
  recibidaEn: Date;
  limiteRespuesta: string;
  limiteEjecucion: string;
  creadoPor: string | null;
}

/** Vista de una solicitud SIN el HMAC ni los ids de lead (solo su número). */
export interface SolicitudArco {
  id: string;
  tipo: TipoArco;
  canal: CanalArco;
  estado: EstadoArco;
  recibidaEn: string;
  limiteRespuesta: string;
  limiteEjecucion: string;
  cerradaEn: string | null;
  leads: number;
  resultado: Conteos | null;
}

export interface ResultadoSupresion {
  conteos: Conteos;
  faltantes: string[];
}

export type ErrorSolicitud = 'NO_ENCONTRADA' | 'TRANSICION_INVALIDA' | 'TIPO_NO_EJECUTABLE';

export interface PrivacidadRepo {
  retencionDiaria(ahora: Date, maxLotes?: number): Promise<ResumenRetencion>;
  registrarSolicitud(s: NuevaSolicitud): Promise<string>;
  obtenerSolicitud(id: string): Promise<SolicitudArco | null>;
  listarSolicitudes(f: { estado?: EstadoArco; limite: number }): Promise<SolicitudArco[]>;
  ejecutarSolicitud(id: string, ahora: Date): Promise<Result<ResultadoSupresion, ErrorSolicitud>>;
  responderSolicitud(id: string, estado: 'respondida' | 'rechazada', motivo: string, ahora: Date): Promise<Result<void, ErrorSolicitud>>;
}

/** = captacion.obtenerContactoLead: teléfono E.164 (sin '+') del lead, o null si ya no existe. */
export interface ContactosPort {
  telefonoDeLead(leadId: string): Promise<string | null>;
}

export interface DepsPrivacidad {
  repo: PrivacidadRepo;
  contactos: ContactosPort;
  clock: Clock;
  logger: Logger;
  /** HMAC_PEPPER: el HMAC del teléfono se calcula aquí, nunca en el cliente ni en la BD. */
  pepper: string;
  /** Días inhábiles adicionales publicados por la autoridad (YYYY-MM-DD). */
  inhabiles?: readonly string[];
}
