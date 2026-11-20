/**
 * Construcción de payloads para Meta CAPI y GA4 (T5, NFR-SEG-04).
 * La PII se normaliza y se hashea con SHA-256 aquí (servidor), nunca en el navegador.
 * Puro salvo por el digest de WebCrypto (determinista, sin I/O).
 */
import { normalizarTelefonoMx, sha256Hex } from '@shared/crypto.ts';
import type { ActionSource } from './eventos.ts';
import { esIpValida } from './ip.ts';

export interface CustomData { vacancy_id: string | null; client_id: string; content_category: string | null }

export interface ContactoParaHash { telefono: string | null; email: string | null; nombrePila: string | null }
export interface ContextoVisitante { visitorId: string | null; ip: string | null; userAgent: string | null; fbc: string | null; fbp: string | null }

export interface UserDataMeta {
  ph?: string[];
  em?: string[];
  fn?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
}

export interface EventoMetaCapi {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: ActionSource;
  event_source_url?: string;
  user_data: UserDataMeta;
  custom_data: Record<string, string>;
}

export function normalizarTelefono(raw: string): string | null {
  const mx = normalizarTelefonoMx(raw);
  if (mx) return mx;
  const d = raw.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export function normalizarEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function normalizarNombre(raw: string): string | null {
  const n = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-zñ]/g, '');
  return n || null;
}

const hash = async (v: string | null): Promise<string[] | undefined> => (v ? [await sha256Hex(v)] : undefined);

/** Quita valores vacíos: Meta y GA4 no aceptan nulos en custom_data/params. */
export function sinVacios(o: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter((kv): kv is [string, string] => typeof kv[1] === 'string' && kv[1] !== ''));
}

export async function construirEventoMeta(e: {
  eventId: string;
  nombreMeta: string;
  actionSource: ActionSource;
  ocurridoEn: Date;
  urlOrigen: string | null;
  customData: Record<string, string | null | undefined>;
  contacto?: ContactoParaHash | null;
  visitante?: ContextoVisitante | null;
}): Promise<EventoMetaCapi> {
  const c = e.contacto;
  const v = e.visitante;
  const user_data: UserDataMeta = {};
  const ph = await hash(c?.telefono ? normalizarTelefono(c.telefono) : null);
  const em = await hash(c?.email ? normalizarEmail(c.email) : null);
  const fn = await hash(c?.nombrePila ? normalizarNombre(c.nombrePila) : null);
  const external_id = await hash(v?.visitorId ?? null);
  if (ph) user_data.ph = ph;
  if (em) user_data.em = em;
  if (fn) user_data.fn = fn;
  if (external_id) user_data.external_id = external_id;
  if (v?.ip && esIpValida(v.ip)) user_data.client_ip_address = v.ip;
  if (v?.userAgent) user_data.client_user_agent = v.userAgent;
  if (v?.fbc) user_data.fbc = v.fbc;
  if (v?.fbp) user_data.fbp = v.fbp;
  return {
    event_name: e.nombreMeta,
    event_time: Math.floor(e.ocurridoEn.getTime() / 1000),
    event_id: e.eventId,
    action_source: e.actionSource,
    ...(e.urlOrigen && e.actionSource === 'website' ? { event_source_url: e.urlOrigen } : {}),
    user_data,
    custom_data: sinVacios(e.customData),
  };
}

export interface EventoGa4Mp {
  client_id: string;
  timestamp_micros: number;
  events: Array<{ name: string; params: Record<string, string | number> }>;
}

export function construirEventoGa4(e: {
  nombre: string;
  clientId: string;
  eventId: string;
  ocurridoEn: Date;
  customData: Record<string, string | null | undefined>;
}): EventoGa4Mp {
  const params = { event_id: e.eventId, ...sinVacios(e.customData), engagement_time_msec: 1 };
  return { client_id: e.clientId, timestamp_micros: e.ocurridoEn.getTime() * 1000, events: [{ name: e.nombre, params }] };
}

export interface MetaCapiRequest { data: EventoMetaCapi[]; test_event_code?: string }
