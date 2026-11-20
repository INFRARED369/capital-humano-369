/**
 * Handler puro de la edge function `tracking-ingest` (TRK-06): CORS por lista blanca, rate limit por IP,
 * tamaño máximo, JSON en text/plain (sendBeacon) y validación Zod estricta. Responde 202 (también en
 * duplicados: T3 idempotente) y nunca devuelve detalles de validación.
 */
import { cors, ipCliente, json, correlationId } from '@shared/http.ts';
import type { Logger } from '@shared/logger.ts';
import { ingerirEvento, type Geo } from '../../application/ingerir.ts';
import type { LimitadorPort, RepoTracking } from '../../application/puertos.ts';
import { TAMANO_MAXIMO_CUERPO } from '../../domain/ingesta.ts';

export interface DepsIngest {
  repo: RepoTracking;
  origenesPermitidos: string[];
  limitador: LimitadorPort;
  log: Logger;
  hostPropio?: string;
}

const CIUDAD = ['cf-ipcity', 'x-vercel-ip-city', 'x-client-city', 'x-geo-city'];
const REGION = ['cf-region-code', 'cf-region', 'x-vercel-ip-country-region', 'x-client-region'];
const PAIS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-client-country', 'x-country'];

function primero(h: Headers, nombres: string[]): string | null {
  for (const n of nombres) {
    const v = h.get(n);
    if (v) {
      try {
        return decodeURIComponent(v).slice(0, 100);
      } catch {
        return v.slice(0, 100);
      }
    }
  }
  return null;
}

export function geoDeHeaders(h: Headers): Geo {
  return { ciudad: primero(h, CIUDAD), region: primero(h, REGION), pais: primero(h, PAIS) };
}

export function crearHandlerIngest(deps: DepsIngest) {
  return async (req: Request): Promise<Response> => {
    const origen = req.headers.get('origin');
    const permitido = origen !== null && deps.origenesPermitidos.includes(origen);
    const h = permitido ? cors(origen) : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: permitido ? 204 : 403, headers: h });
    if (req.method !== 'POST') return json({ error: 'METODO' }, 405, h);
    if (!permitido) return json({ error: 'ORIGEN' }, 403);

    const ip = ipCliente(req);
    if (!deps.limitador.permitir(ip ?? 'sin-ip')) return json({ error: 'LIMITE' }, 429, { ...h, 'retry-after': '60' });

    const largo = Number(req.headers.get('content-length') ?? '0');
    if (largo > TAMANO_MAXIMO_CUERPO) return json({ error: 'TAMANO' }, 413, h);
    const texto = await req.text();
    if (new TextEncoder().encode(texto).length > TAMANO_MAXIMO_CUERPO) return json({ error: 'TAMANO' }, 413, h);

    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      return json({ error: 'INVALIDO' }, 400, h);
    }

    const log = deps.log.child({ fn: 'tracking-ingest', correlation_id: correlationId(req) });
    try {
      const r = await ingerirEvento({ repo: deps.repo, hostPropio: deps.hostPropio }, { cuerpo, ip, userAgent: req.headers.get('user-agent'), geo: geoDeHeaders(req.headers) });
      if (!r.ok) return json({ error: r.error }, 400, h);
      return json({ ok: true, registro: r.value.registro }, 202, h);
    } catch (e) {
      log.error('tracking-ingest: error', { error: (e as Error).message });
      return json({ error: 'INTERNO' }, 500, h);
    }
  };
}
