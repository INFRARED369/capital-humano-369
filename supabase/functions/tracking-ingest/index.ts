/**
 * tracking-ingest (TRK-06): navegador → Supabase (tracking.eventos) → cola tracking-capi.
 * verify_jwt = false (sendBeacon no puede mandar Authorization); protegido por CORS, rate limit y Zod.
 * Rate limit híbrido: 120/min por IP en memoria del isolate + TRACKING_RATE_LIMIT_GLOBAL/min por red /24 sumando
 * todos los isolates en shared.rate_limit, actualizado en lotes (50 eventos o 5 s), nunca una consulta por evento.
 * TRK-07: el lugar sale de headers del CDN aquí; el respaldo por IP (GEOIP_URL) corre en tracking-capi-worker.
 * Solo arma dependencias: la lógica vive en src/domains/tracking (probada en Node).
 */
import { entornoDeno, servir, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import {
  crearContadorGlobalSql, crearHandlerIngest, crearLimitadorHibrido, crearLimitadorMemoria, crearRepoTrackingSql,
} from '@domains/tracking/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'ALLOWED_ORIGIN', 'HMAC_PEPPER']);
const sql = sqlDeno(env.SUPABASE_DB_URL);
const global = Number(Deno.env.get('TRACKING_RATE_LIMIT_GLOBAL') ?? '600');
const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;

const limitador = crearLimitadorHibrido({
  local: crearLimitadorMemoria({ max: 120, ventanaMs: 60_000 }, systemClock),
  contador: crearContadorGlobalSql(sql, env.HMAC_PEPPER),
  limiteGlobal: Number.isFinite(global) && global > 0 ? global : 600,
  ventanaMs: 60_000,
  loteEventos: 50,
  intervaloMs: 5_000,
  clock: systemClock,
  log: crearLogger({ funcion: 'tracking-ingest' }),
  programar: (p) => runtime?.waitUntil?.(p),
});

Deno.serve(servir((req, ctx) => crearHandlerIngest({
  repo: crearRepoTrackingSql(sql),
  origenesPermitidos: [...env.ALLOWED_ORIGIN],
  limitador,
  log: ctx.log,
  hostPropio: new URL(env.ALLOWED_ORIGIN[0]!).hostname.replace(/^www\./, ''),
})(req), { funcion: 'tracking-ingest', origenes: env.ALLOWED_ORIGIN }));
