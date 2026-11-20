/** Tipos del dominio de sincronización con el calendario externo (Zoho Calendar como capa de acceso, D8). */

/** Evento tal como existe en el calendario externo (normalizado, fechas ISO UTC). */
export interface EventoRemoto {
  uid: string;
  etag: string;
  titulo: string;
  descripcion: string;
  inicio: string;
  fin: string;
  /** UID propio del sistema leído del marcador en la descripción; null si el evento no es nuestro. */
  uidPropio: string | null;
  numAsistentes: number;
}

/**
 * Clasificación de errores del proveedor:
 *  - transitorio: 5xx, 429, red → reintentar con backoff
 *  - conflicto: etag desactualizado (412) → reintentar (se relee el etag)
 *  - auth: token inválido tras renovar (Z6) → no reintentar, alerta
 *  - no_encontrado: 404
 *  - permanente: 4xx de validación → no reintentar
 */
export type TipoErrorCalendario = 'transitorio' | 'conflicto' | 'auth' | 'no_encontrado' | 'permanente';
export interface ErrorCalendario {
  tipo: TipoErrorCalendario;
  mensaje: string;
  status?: number;
}

export type TipoAlertaZoho =
  | 'ZOHO_DRIFT'
  | 'ZOHO_DEAD_LETTER'
  | 'ZOHO_CONFIG_INCOMPLETA'
  | 'ZOHO_AUTH'
  | 'ZOHO_RECONCILIACION_ERROR'
  | 'ZOHO_SIN_REGISTRO';
