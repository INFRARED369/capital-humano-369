/**
 * ZohoCalendarAdapter: CalendarioExternoPort contra la API REST de Zoho Calendar v1.
 *   Eventos: https://calendar.zoho.{dc}/api/v1/calendars/{calendar_uid}/events[/{event_uid}]
 *   OAuth:   https://accounts.zoho.{dc}/oauth/v2/token (grant_type=refresh_token)
 * Scope mínimo de la app OAuth: ZohoCalendar.event.ALL (NFR-SEG-06). El refresh token lo
 * provee el entorno (Vault → env de la edge function); nunca se registra en logs.
 * Z6: ante 401 se renueva el access token y se reintenta UNA vez.
 */
import { err, ok, type Result } from '@shared/result.ts';
import type { Clock } from '@shared/clock.ts';
import type { Logger } from '@shared/logger.ts';
import type { CalendarioExternoPort, RangoFechas } from '../application/puertos.ts';
import { extraerUidPropio, type EventoCalendario } from '../domain/evento.ts';
import type { ErrorCalendario, EventoRemoto } from '../domain/tipos.ts';
import { ZohoErrorSchema, ZohoEventoSchema, ZohoEventosRespuestaSchema, ZohoListaCrudaSchema, ZohoTokenErrorSchema, ZohoTokenOkSchema, aEventDataZoho, aEventoRemoto, aRangoZoho } from './zohoSchemas.ts';

export interface ZohoConfig {
  /** Data center (Q-2 pendiente): com | eu | in | com.au | jp | ca | sa | com.cn */
  dc: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Caché del access token compartida entre isolates (Zoho limita los access tokens por refresh token:
 * ~10 cada 10 min). Implementación: citas.zoho_token_cache, cifrada (zohoTokenCache.ts).
 */
export interface TokenCachePort {
  leer(): Promise<{ token: string; venceEn: number } | null>;
  guardar(token: string, venceEn: number): Promise<void>;
}

export interface ZohoAdapterDeps {
  fetch: typeof fetch;
  clock: Clock;
  logger: Logger;
  timeoutMs?: number;
  tokenCache?: TokenCachePort;
}

/** Dominios por data center (lista cerrada: el valor de entorno nunca forma un host arbitrario). */
const DOMINIOS: Record<string, { accounts: string; calendar: string }> = {
  com: { accounts: 'https://accounts.zoho.com', calendar: 'https://calendar.zoho.com' },
  eu: { accounts: 'https://accounts.zoho.eu', calendar: 'https://calendar.zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', calendar: 'https://calendar.zoho.in' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', calendar: 'https://calendar.zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', calendar: 'https://calendar.zoho.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', calendar: 'https://calendar.zohocloud.ca' },
  sa: { accounts: 'https://accounts.zoho.sa', calendar: 'https://calendar.zoho.sa' },
  'com.cn': { accounts: 'https://accounts.zoho.com.cn', calendar: 'https://calendar.zoho.com.cn' },
};

export function dominiosZoho(dc: string): { accounts: string; calendar: string } {
  const d = Object.hasOwn(DOMINIOS, dc) ? DOMINIOS[dc] : undefined;
  if (!d) throw new Error(`ZOHO_DC inválido: use uno de ${Object.keys(DOMINIOS).join(', ')}`);
  return d;
}

/** Margen para renovar antes de que venza el access token. */
const MARGEN_MS = 5 * 60_000;

type Http = { status: number; body: unknown };

/** Texto del proveedor sin datos personales: sin correos, teléfonos (7+ dígitos) ni tokens; máx. 120 caracteres. */
export function textoSeguro(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[A-Za-z0-9_=+/-]{24,}/g, '…')
    .replace(/[\p{L}\p{N}._+-]+@[\p{L}\p{N}.-]+/gu, '')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '#')
    .replace(/[{}"[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Motivo legible del error de Zoho: código + mensaje/descripción/campo del primer error, o los nombres de las
 * llaves si la forma es desconocida (para diagnosticar sin volcar el cuerpo, que puede repetir el título).
 */
export function motivoZoho(body: unknown): string {
  const e = ZohoErrorSchema.safeParse(body);
  const raw = e.success ? e.data.error : undefined;
  const item = Array.isArray(raw) ? raw[0] : raw;
  if (typeof item === 'string') return textoSeguro(item);
  if (item && typeof item === 'object') {
    const i = item as Record<string, unknown>;
    return [i.code, i.message, i.description, i.field, i.key].map(textoSeguro).filter(Boolean).join(' · ').slice(0, 160);
  }
  if (body && typeof body === 'object') return `llaves: ${Object.keys(body).slice(0, 8).join(',')}`;
  return body == null ? 'sin cuerpo' : textoSeguro(String(body));
}

function clasificar(status: number, body: unknown): ErrorCalendario {
  const detalle = motivoZoho(body);
  const mensaje = `HTTP ${status}${detalle ? ` ${detalle}` : ''}`;
  if (status === 404) return { tipo: 'no_encontrado', status, mensaje };
  if (status === 412) return { tipo: 'conflicto', status, mensaje };
  if (status === 401) return { tipo: 'auth', status, mensaje };
  if (status === 408 || status === 429 || status >= 500) return { tipo: 'transitorio', status, mensaje };
  return { tipo: 'permanente', status, mensaje };
}

const fueraDeContrato = (op: string): ErrorCalendario => ({ tipo: 'permanente', mensaje: `respuesta de ${op} fuera de contrato` });

/** Diagnóstico sin datos: solo rutas y códigos de zod (p. ej. "dateandtime.start:too_small"). */
const problemas = (e: { issues: { path: PropertyKey[]; code: string }[] }) => e.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.')}:${i.code}`);
const llaves = (body: unknown) => (body && typeof body === 'object' ? Object.keys(body).slice(0, 10) : [typeof body]);

export function crearZohoCalendarAdapter(cfg: ZohoConfig, deps: ZohoAdapterDeps): CalendarioExternoPort {
  const dom = dominiosZoho(cfg.dc);
  const log = deps.logger.child({ proveedor: 'zoho-calendar' });
  const timeout = deps.timeoutMs ?? 10_000;
  let cache: { token: string; venceEn: number } | null = null;

  async function enviar(url: string, init: RequestInit): Promise<Result<Http, ErrorCalendario>> {
    try {
      const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      const txt = await res.text();
      let body: unknown = null;
      try { body = txt ? JSON.parse(txt) : null; } catch { body = res.ok ? null : txt.slice(0, 300); }
      return ok({ status: res.status, body });
    } catch (e) {
      return err({ tipo: 'transitorio', mensaje: `red: ${(e as Error).name}` });
    }
  }

  async function token(forzar: boolean): Promise<Result<string, ErrorCalendario>> {
    const ahora = deps.clock.now().getTime();
    if (!forzar && cache && ahora < cache.venceEn - MARGEN_MS) return ok(cache.token);
    cache = null;
    if (!forzar && deps.tokenCache) {
      try {
        const g = await deps.tokenCache.leer();
        if (g && ahora < g.venceEn - MARGEN_MS) {
          cache = g;
          return ok(g.token);
        }
      } catch (e) {
        log.warn('zoho: caché de token no disponible', { error: (e as Error).name });
      }
    }
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret });
    const r = await enviar(`${dom.accounts}/oauth/v2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!r.ok) return r;
    if (r.value.status === 429 || r.value.status >= 500) return err({ tipo: 'transitorio', status: r.value.status, mensaje: `oauth HTTP ${r.value.status}` });
    const t = ZohoTokenOkSchema.safeParse(r.value.body);
    if (!t.success) {
      const e = ZohoTokenErrorSchema.safeParse(r.value.body);
      log.error('zoho: no se pudo renovar el access token', { status: r.value.status, motivo: e.success ? e.data.error.slice(0, 60) : 'respuesta inválida' });
      return err({ tipo: 'auth', status: r.value.status, mensaje: 'refresh token rechazado' });
    }
    cache = { token: t.data.access_token, venceEn: ahora + t.data.expires_in * 1000 };
    if (deps.tokenCache) {
      try {
        await deps.tokenCache.guardar(cache.token, cache.venceEn);
      } catch (e) {
        log.warn('zoho: no se pudo guardar el token en la caché', { error: (e as Error).name });
      }
    }
    return ok(t.data.access_token);
  }

  /** Llamada autenticada; Z6: 401 → renovar token y reintentar una sola vez. */
  async function api(method: string, ruta: string, opts: { query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Result<Http, ErrorCalendario>> {
    const url = new URL(`${dom.calendar}/api/v1${ruta}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    let respuesta: Http | null = null;
    for (const forzar of [false, true]) {
      const t = await token(forzar);
      if (!t.ok) return t;
      const r = await enviar(url.toString(), { method, headers: { ...opts.headers, authorization: `Zoho-oauthtoken ${t.value}`, accept: 'application/json' } });
      if (!r.ok) return r;
      respuesta = r.value;
      if (respuesta.status !== 401) break;
      if (!forzar) log.warn('zoho: access token rechazado (401), renovando y reintentando 1 vez', { metodo: method });
    }
    const { status, body } = respuesta!;
    if (status >= 200 && status < 300) return ok({ status, body });
    const e = clasificar(status, body);
    if (e.tipo !== 'no_encontrado') log.warn('zoho: error de API', { metodo: method, status, error: e.mensaje });
    return err(e);
  }

  const ruta = (cal: string, uid?: string) => `/calendars/${encodeURIComponent(cal)}/events${uid !== undefined ? `/${encodeURIComponent(uid)}` : ''}`;

  function eventos(op: string, body: unknown): Result<EventoRemoto[], ErrorCalendario> {
    if (body == null) return ok([]);
    const p = ZohoEventosRespuestaSchema.safeParse(body);
    if (!p.success) {
      log.error('zoho: respuesta fuera de contrato', { op, llaves: llaves(body), problemas: problemas(p.error) });
      return err(fueraDeContrato(op));
    }
    try {
      return ok(p.data.events.map(aEventoRemoto));
    } catch {
      log.error('zoho: fecha fuera de contrato', { op });
      return err(fueraDeContrato(op));
    }
  }

  /**
   * Listado del calendario: ahí también viven eventos que no creó el sistema (juntas, eventos de día completo,
   * recurrentes…). Los que no tienen la forma esperada se omiten con un aviso, salvo que lleven la marca propia.
   * Sin `events` ni `error` (Zoho no siempre manda la lista vacía) → sin eventos.
   */
  function lista(body: unknown): Result<EventoRemoto[], ErrorCalendario> {
    if (body == null) return ok([]);
    const crudo = ZohoListaCrudaSchema.safeParse(body);
    if (!crudo.success) {
      if (typeof body === 'object' && !Array.isArray(body) && !('error' in body)) {
        log.warn('zoho: listado sin events, se toma como vacío', { llaves: llaves(body) });
        return ok([]);
      }
      log.error('zoho: respuesta fuera de contrato', { op: 'listar', llaves: llaves(body) });
      return err(fueraDeContrato('listar'));
    }
    const out: EventoRemoto[] = [];
    let omitidos = 0;
    let detalle: string[] = [];
    for (const raw of crudo.data.events) {
      const ev = ZohoEventoSchema.safeParse(raw);
      let remoto: EventoRemoto | null = null;
      if (ev.success) {
        try { remoto = aEventoRemoto(ev.data); } catch { detalle = ['dateandtime:formato']; }
      } else detalle = problemas(ev.error);
      if (remoto) { out.push(remoto); continue; }
      const desc = raw && typeof raw === 'object' ? (raw as { description?: unknown }).description : undefined;
      // Un evento nuestro (lleva el UID propio) nunca se descarta en silencio: podría duplicarse al recrearlo.
      if (typeof desc === 'string' && extraerUidPropio(desc)) {
        log.error('zoho: evento propio fuera de contrato', { op: 'listar', problemas: detalle });
        return err(fueraDeContrato('listar'));
      }
      omitidos++;
    }
    if (omitidos > 0) log.warn('zoho: eventos ajenos con formato no reconocido omitidos', { omitidos, total: crudo.data.events.length, problemas: detalle });
    return ok(out);
  }

  function uno(op: string, body: unknown): Result<EventoRemoto, ErrorCalendario> {
    const l = eventos(op, body);
    if (!l.ok) return l;
    return l.value[0] ? ok(l.value[0]) : err(fueraDeContrato(op));
  }

  const eventdata = (e: EventoCalendario, etag?: string) => ({ eventdata: JSON.stringify(aEventDataZoho(e, etag)) });

  return {
    async crear(cal, e) {
      const r = await api('POST', ruta(cal), { query: eventdata(e) });
      return r.ok ? uno('crear', r.value.body) : r;
    },
    async actualizar(cal, uid, etag, e) {
      const r = await api('PUT', ruta(cal, uid), { query: eventdata(e, etag) });
      return r.ok ? uno('actualizar', r.value.body) : r;
    },
    async borrar(cal, uid, etag) {
      const r = await api('DELETE', ruta(cal, uid), { headers: { etag } });
      if (r.ok || r.error.tipo === 'no_encontrado') return ok(undefined);
      return r;
    },
    async obtener(cal, uid) {
      const r = await api('GET', ruta(cal, uid));
      if (!r.ok) return r.error.tipo === 'no_encontrado' ? ok(null) : r;
      const l = eventos('obtener', r.value.body);
      return l.ok ? ok(l.value[0] ?? null) : l;
    },
    async listar(cal, rango: RangoFechas) {
      const r = await api('GET', ruta(cal), { query: { range: JSON.stringify(aRangoZoho(rango.desde, rango.hasta)) } });
      return r.ok ? lista(r.value.body) : r;
    },
  };
}
