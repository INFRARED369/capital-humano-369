/**
 * Eventos de dominio publicados por outbox (shared.outbox). Contrato entre dominios.
 * Ningún payload lleva PII en claro (solo ids, folio y nombre de pila cuando es imprescindible).
 */
export type EventoDominio =
  | { tipo: 'LeadCreado'; payload: { lead_id: string; vacante_id: string; cliente_id: string; folio: string; event_id: string; visitor_id: string | null; origen: string | null } }
  | { tipo: 'CitaRetenida'; payload: { cita_id: string; lead_id: string; vacante_id: string; cliente_id: string; inicio: string; expira_en: string } }
  | { tipo: 'WhatsAppVerificado'; payload: { lead_id: string; vacante_id: string; cliente_id: string; event_id: string } }
  | { tipo: 'CitaConfirmada'; payload: { cita_id: string; lead_id: string; vacante_id: string; cliente_id: string; inicio: string; fin: string; folio: string; nombre_pila: string; reglas_version: number; event_id: string } }
  | { tipo: 'CitaCancelada'; payload: { cita_id: string; lead_id: string; vacante_id: string; cliente_id: string; motivo: string } }
  | { tipo: 'CitaReprogramada'; payload: { cita_id: string; cita_anterior_id: string; lead_id: string; vacante_id: string; cliente_id: string; inicio: string; fin: string; folio: string; nombre_pila: string } }
  | { tipo: 'CitaExpirada'; payload: { cita_id: string; lead_id: string; vacante_id: string; cliente_id: string } }
  | { tipo: 'AsistenciaRegistrada'; payload: { cita_id: string; lead_id: string; vacante_id: string; cliente_id: string; asistio: boolean; event_id: string } }
  | { tipo: 'LeadContratado'; payload: { lead_id: string; vacante_id: string; cliente_id: string; cita_id: string | null; entregado_en: string | null; event_id: string } }
  | { tipo: 'MensajeEnviado'; payload: { mensaje_id: string; lead_id: string | null; vacante_id: string | null; cliente_id: string; canal: string; proveedor: string; costo_mxn: number; intento: number } }
  | { tipo: 'MensajeFallido'; payload: { mensaje_id: string; canal: string; cliente_id: string; motivo: string } }
  | { tipo: 'LeadSuprimido'; payload: { lead_id: string; vacante_id: string; cliente_id: string; regla: string } };

export type TipoEvento = EventoDominio['tipo'];
export type PayloadDe<T extends TipoEvento> = Extract<EventoDominio, { tipo: T }>['payload'];
