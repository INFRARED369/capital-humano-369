/**
 * TRK-07 · Adaptadores de GeoIpPort.
 *  - HTTP configurable: GEOIP_URL con plantilla `{ip}` (https), p. ej. `https://ipapi.co/{ip}/json/` o
 *    `https://ipinfo.io/{ip}/json?token=…`. Timeout corto (GEOIP_TIMEOUT_MS, 1500 ms) y caché en memoria por red.
 *  - Nulo (sin GEOIP_URL): siempre null.
 * Solo se conserva ciudad, región y país (ISO-2); el resto de la respuesta (coordenadas, ISP, …) se descarta.
 */
import type { Clock } from '@shared/clock.ts';
import { systemClock } from '@shared/clock.ts';
import type { Geo, GeoIpPort } from '../../application/puertos.ts';

export const geoIpNulo: GeoIpPort = { resolver: async () => null };

const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Normaliza respuestas de ipapi.co, ipinfo.io e ip-api.com. */
export function normalizarRespuestaGeo(cuerpo: unknown): Geo | null {
  const r = obj(cuerpo);
  if (!r || r.error === true || r.bogon === true || r.status === 'fail') return null;
  const paisCrudo = txt(r.country_code) ?? txt(r.countryCode) ?? txt(r.country);
  const pais = paisCrudo && /^[A-Za-z]{2}$/.test(paisCrudo) ? paisCrudo.toUpperCase() : null;
  const geo: Geo = { ciudad: txt(r.city), region: txt(r.region) ?? txt(r.regionName) ?? txt(r.region_name), pais };
  return geo.ciudad || geo.region || geo.pais ? geo : null;
}

export interface ConfigGeoIpHttp {
  urlPlantilla: string;
  fetch: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
  ttlMs?: number;
  maxCache?: number;
}

export function crearGeoIpHttp(cfg: ConfigGeoIpHttp): GeoIpPort {
  if (!cfg.urlPlantilla.includes('{ip}')) throw new Error('GEOIP_URL debe contener {ip}');
  if (!/^https:\/\/[^\s]+$/.test(cfg.urlPlantilla)) throw new Error('GEOIP_URL debe ser https');
  const clock = cfg.clock ?? systemClock;
  const ttl = cfg.ttlMs ?? 24 * 3_600_000;
  const max = cfg.maxCache ?? 10_000;
  const cache = new Map<string, { geo: Geo | null; vence: number }>();

  return {
    async resolver(ip) {
      const ahora = clock.now().getTime();
      const c = cache.get(ip);
      if (c && c.vence > ahora) return c.geo;
      let geo: Geo | null = null;
      let cachear = true;
      try {
        const res = await cfg.fetch(cfg.urlPlantilla.replace('{ip}', encodeURIComponent(ip)), {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 1500),
        });
        if (res.ok) geo = normalizarRespuestaGeo(await res.json());
        else {
          await res.body?.cancel();
          cachear = res.status < 500 && res.status !== 429;
        }
      } catch {
        cachear = false; // red/timeout: no envenenar la caché
      }
      if (cachear) {
        cache.delete(ip);
        cache.set(ip, { geo, vence: ahora + ttl });
        if (cache.size > max) cache.delete(cache.keys().next().value!);
      }
      return geo;
    },
  };
}

/** GEOIP_URL (+ GEOIP_TIMEOUT_MS) → adaptador HTTP; sin GEOIP_URL → nulo. */
export function crearGeoIpDesdeEntorno(env: Record<string, string | undefined>, fetchImpl: typeof fetch): GeoIpPort {
  if (!env.GEOIP_URL) return geoIpNulo;
  const t = Number(env.GEOIP_TIMEOUT_MS);
  return crearGeoIpHttp({ urlPlantilla: env.GEOIP_URL, fetch: fetchImpl, timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(t, 5000) : undefined });
}
