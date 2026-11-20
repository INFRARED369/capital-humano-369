/**
 * Contrato de la API REST de Zoho Calendar v1 (eventos) y del endpoint OAuth de Zoho Accounts.
 * Formato: `eventdata` (JSON en query) con title, description, dateandtime{timezone,start,end}, etag (update).
 * Fechas Zoho: yyyyMMdd'T'HHmmss'Z' | yyyyMMdd'T'HHmmss±hhmm | yyyyMMdd (rango).
 */
import { z } from 'zod';
import { extraerUidPropio, type EventoCalendario } from '../domain/evento.ts';
import type { EventoRemoto } from '../domain/tipos.ts';

/**
 * Evento tal como lo devuelve Zoho. Tolerante en lo que el sistema no usa (Zoho manda null, strings en
 * booleanos o asistentes con otra forma en eventos creados desde su app); estricto en uid/etag/fechas.
 */
export const ZohoEventoSchema = z
  .object({
    uid: z.string().min(1),
    etag: z.union([z.number(), z.string().min(1)]),
    title: z.string().nullish().transform((t) => t ?? ''),
    description: z.string().nullish().transform((d) => d ?? undefined),
    isallday: z.union([z.boolean(), z.string()]).nullish(),
    dateandtime: z.object({ timezone: z.string().nullish(), start: z.string().min(8), end: z.string().min(8) }).passthrough(),
    attendees: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type ZohoEvento = z.infer<typeof ZohoEventoSchema>;

export const ZohoEventosRespuestaSchema = z.object({ events: z.array(ZohoEventoSchema) }).passthrough();
/** Envoltura del listado: cada evento se valida por separado (uno ajeno raro no tumba la sincronización). */
export const ZohoListaCrudaSchema = z.object({ events: z.array(z.unknown()) }).passthrough();

export const ZohoTokenOkSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive(), api_domain: z.string().optional(), token_type: z.string().optional() });
export const ZohoTokenErrorSchema = z.object({ error: z.string() });
export const ZohoTokenRespuestaSchema = z.union([ZohoTokenOkSchema, ZohoTokenErrorSchema]);

const ErrorItem = z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough();
export const ZohoErrorSchema = z.object({ error: z.union([z.string(), ErrorItem, z.array(ErrorItem)]) }).passthrough();

/**
 * Lo que el sistema envía a Zoho: estricto (D9) — sin attendees, sin recordatorios, sin campos extra.
 * `reminders` se omite: Zoho rechaza la lista vacía (400 ARRAY_SIZE_OUT_OF_RANGE, acepta 1–4).
 */
export const EventDataSalidaSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(1000),
    dateandtime: z.object({ timezone: z.string().min(1), start: z.string().regex(/^\d{8}T\d{6}Z$/), end: z.string().regex(/^\d{8}T\d{6}Z$/) }),
    isallday: z.literal(false),
    etag: z.union([z.number(), z.string()]).optional(),
  })
  .strict();
export type EventDataSalida = z.infer<typeof EventDataSalidaSchema>;

const pad = (n: number) => String(n).padStart(2, '0');

export function aFechaZoho(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const diaZoho = (iso: string): string => aFechaZoho(iso).slice(0, 8);

/** Rango de listado (Zoho acepta días yyyyMMdd; máximo 31 días por consulta). */
export const aRangoZoho = (desdeIso: string, hastaIso: string) => ({ start: diaZoho(desdeIso), end: diaZoho(hastaIso) });

const FECHA_ZOHO = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?)?$/;

export function deFechaZoho(s: string): string {
  const m = FECHA_ZOHO.exec(s);
  if (!m) throw new Error(`Fecha de Zoho inválida: ${s}`);
  const [, y, mo, d, h = '00', mi = '00', se = '00', zona = 'Z'] = m;
  const offset = zona === 'Z' ? 'Z' : `${zona.slice(0, 3)}:${zona.slice(3)}`;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`).toISOString();
}

export function aEventoRemoto(e: ZohoEvento): EventoRemoto {
  const descripcion = e.description ?? '';
  return {
    uid: e.uid,
    etag: String(e.etag),
    titulo: e.title,
    descripcion,
    inicio: deFechaZoho(e.dateandtime.start),
    fin: deFechaZoho(e.dateandtime.end),
    uidPropio: extraerUidPropio(descripcion),
    numAsistentes: e.attendees?.length ?? 0,
  };
}

const etagZoho = (etag: string): number | string => (/^\d{1,15}$/.test(etag) ? Number(etag) : etag);

export function aEventDataZoho(e: EventoCalendario, etag?: string): EventDataSalida {
  return {
    title: e.titulo,
    description: e.descripcion,
    dateandtime: { timezone: e.zonaHoraria, start: aFechaZoho(e.inicio), end: aFechaZoho(e.fin) },
    isallday: false,
    ...(etag !== undefined ? { etag: etagZoho(etag) } : {}),
  };
}
