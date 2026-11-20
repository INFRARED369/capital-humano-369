/**
 * TRK-04 / §8 · Catálogo de eventos del funnel y su mapeo a Meta (CAPI) y GA4. Puro.
 * Los eventos de servidor (outbox) nunca se aceptan desde el navegador (T8).
 */
export const EVENTOS_NAVEGADOR = [
  'PageView', 'ConsentAccepted', 'VideoPlay', 'VideoProgress50', 'VideoComplete', 'ClickCTA', 'SectionView', 'FormStarted', 'FormSubmitted',
] as const;
export const EVENTOS_SERVIDOR = ['LeadCreado', 'WhatsAppVerificado', 'CitaConfirmada', 'AsistenciaRegistrada', 'LeadContratado'] as const;

export type EventoNavegador = (typeof EVENTOS_NAVEGADOR)[number];
export type EventoServidor = (typeof EVENTOS_SERVIDOR)[number];
export type EventoFunnel = EventoNavegador | EventoServidor;

export type ActionSource = 'website' | 'system_generated';
export type Destino = 'meta' | 'ga4';
export interface EventoMeta { nombre: string; actionSource: ActionSource }

const META: Partial<Record<EventoFunnel, EventoMeta>> = {
  PageView: { nombre: 'PageView', actionSource: 'website' },
  VideoPlay: { nombre: 'ViewContent', actionSource: 'website' },
  ClickCTA: { nombre: 'Contact', actionSource: 'website' },
  LeadCreado: { nombre: 'Lead', actionSource: 'website' },
  CitaConfirmada: { nombre: 'Schedule', actionSource: 'website' },
  // TRK-09: contratación desde el panel. Custom (Meta no tiene estándar para "contratado"); offline.
  LeadContratado: { nombre: 'Contratado', actionSource: 'system_generated' },
};

/** Evento offline de asistencia (TRK-09). Estándar para que Meta pueda optimizar. */
export const EVENTO_META_ASISTENCIA: EventoMeta = { nombre: 'CompleteRegistration', actionSource: 'system_generated' };

const GA4: Partial<Record<EventoFunnel, string>> = {
  PageView: 'page_view',
  VideoPlay: 'video_start',
  VideoProgress50: 'video_progress',
  VideoComplete: 'video_complete',
  ClickCTA: 'click_cta',
  SectionView: 'section_view',
  FormStarted: 'form_start',
  FormSubmitted: 'form_submit',
  LeadCreado: 'generate_lead',
  WhatsAppVerificado: 'whatsapp_verified',
  CitaConfirmada: 'schedule_interview',
  AsistenciaRegistrada: 'interview_attended',
  LeadContratado: 'candidate_hired',
};

export function eventoMeta(nombre: EventoFunnel, props: Record<string, unknown>): EventoMeta | null {
  if (nombre === 'AsistenciaRegistrada') return props.asistio === true ? EVENTO_META_ASISTENCIA : null;
  return META[nombre] ?? null;
}

export function eventoGa4(nombre: EventoFunnel): string | null {
  return GA4[nombre] ?? null;
}

export const esEventoServidor = (n: string): n is EventoServidor => (EVENTOS_SERVIDOR as readonly string[]).includes(n);

/**
 * A qué terceros se envía un evento. Sin consentimiento: a nadie.
 * T8: los eventos de servidor (Lead, Schedule, offline) solo salen si el origen es el servidor.
 */
export function destinosDe(
  nombre: EventoFunnel,
  props: Record<string, unknown>,
  ctx: { consentimiento: boolean; origen: 'navegador' | 'servidor' },
): Destino[] {
  if (!ctx.consentimiento) return [];
  if (esEventoServidor(nombre) && ctx.origen !== 'servidor') return [];
  const destinos: Destino[] = [];
  if (eventoMeta(nombre, props)) destinos.push('meta');
  if (eventoGa4(nombre)) destinos.push('ga4');
  return destinos;
}
