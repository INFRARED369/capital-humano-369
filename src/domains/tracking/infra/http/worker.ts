/**
 * Handler puro de la edge function `tracking-capi-worker` (invocada por cron): consume el outbox
 * (consumidor 'tracking'), recupera mensajes vencidos y procesa la cola 'tracking-capi'.
 * Protegido con un secreto compartido (Authorization: Bearer <TRACKING_WORKER_SECRET>).
 */
import { json } from '@shared/http.ts';
import { timingSafeEqual } from '@shared/crypto.ts';
import type { SqlClient } from '@shared/sql.ts';
import type { Logger } from '@shared/logger.ts';
import { procesarOutbox, CONSUMIDOR } from '../../application/consumidor-outbox.ts';
import { procesarColaCapi } from '../../application/worker-capi.ts';
import { enriquecerGeo, type ResumenGeo } from '../../application/enriquecer-geo.ts';
import type { ContactosPort, Ga4Port, GeoIpPort, MetaCapiPort } from '../../application/puertos.ts';
import { crearColaSql, crearOutboxSql, crearRepoTrackingSql } from '../sql/repositorio.ts';
import { crearRepoGeoSql } from '../sql/geo.ts';

export interface DepsTrabajoTracking {
  sql: SqlClient;
  meta: MetaCapiPort;
  ga4: Ga4Port;
  contactos: ContactosPort;
  config: { sitioUrl: string; testEventCode?: string; capiSinCookies?: boolean };
  log: Logger;
  /** TRK-07 (b): solo si hay proveedor (GEOIP_URL). Sin él, el lugar sale únicamente de los headers del CDN. */
  geoIp?: GeoIpPort;
}

export async function correrTrabajoTracking(deps: DepsTrabajoTracking, lote = 50) {
  const outbox = await procesarOutbox({
    enTransaccion: (fn) => deps.sql.transaction((tx) => fn({ repo: crearRepoTrackingSql(tx), outbox: crearOutboxSql(tx, CONSUMIDOR) })),
    politica: { capiSinCookies: deps.config.capiSinCookies === true },
    log: deps.log,
  }, lote * 2);
  await deps.sql.query('select shared.recuperar_vencidos()');
  const capi = await procesarColaCapi({
    cola: crearColaSql(deps.sql),
    repo: crearRepoTrackingSql(deps.sql),
    meta: deps.meta,
    ga4: deps.ga4,
    contactos: deps.contactos,
    config: { sitioUrl: deps.config.sitioUrl, testEventCode: deps.config.testEventCode },
    log: deps.log,
  }, lote);
  if (!deps.geoIp) return { outbox, capi };
  let geo: ResumenGeo | { error: string };
  try {
    geo = await enriquecerGeo({ repo: crearRepoGeoSql(deps.sql), geoIp: deps.geoIp, log: deps.log }, lote * 2);
  } catch (e) {
    // El lugar de acceso es secundario: nunca debe tumbar el envío a CAPI.
    deps.log.warn('geoip: lote fallido', { error: (e as Error).name });
    geo = { error: 'GEO_FALLIDO' };
  }
  return { outbox, capi, geo };
}

export function crearHandlerWorker(deps: { secreto: string; correr: () => Promise<unknown>; log: Logger }) {
  if (deps.secreto.length < 16) throw new Error('TRACKING_WORKER_SECRET demasiado corto');
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'METODO' }, 405);
    const auth = req.headers.get('authorization') ?? '';
    if (!timingSafeEqual(auth, `Bearer ${deps.secreto}`)) return json({ error: 'NO_AUTORIZADO' }, 401);
    try {
      return json({ ok: true, ...(await deps.correr() as object) });
    } catch (e) {
      deps.log.error('tracking-capi-worker: error', { error: (e as Error).message });
      return json({ error: 'INTERNO' }, 500);
    }
  };
}
