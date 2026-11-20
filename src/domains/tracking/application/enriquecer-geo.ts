/**
 * TRK-07 · Enriquecimiento geográfico asíncrono (corre en tracking-capi-worker, fuera de la ruta de la ingesta).
 * Agrupa por /24 (IPv4) o /48 (IPv6): una consulta por red y se envía la red truncada al proveedor,
 * nunca la IP completa. Sin dato o con error del proveedor, el evento se marca intentado (no se reintenta).
 */
import type { Logger } from '@shared/logger.ts';
import { truncarIp } from '../domain/ip.ts';
import type { Geo, GeoIpPort, RepoGeoPort } from './puertos.ts';

export interface ResumenGeo { pendientes: number; consultas: number; resueltos: number; sin_dato: number }

const util = (g: Geo | null): g is Geo => !!g && !!(g.ciudad || g.region || g.pais);

export async function enriquecerGeo(d: { repo: RepoGeoPort; geoIp: GeoIpPort; log: Logger }, lote = 100): Promise<ResumenGeo> {
  const pendientes = await d.repo.pendientes(lote);
  const resumen: ResumenGeo = { pendientes: pendientes.length, consultas: 0, resueltos: 0, sin_dato: 0 };
  if (pendientes.length === 0) return resumen;

  const porRed = new Map<string, Promise<Geo | null>>();
  const resolver = (red: string) => {
    let p = porRed.get(red);
    if (!p) {
      resumen.consultas++;
      p = d.geoIp.resolver(red).catch((e: unknown) => {
        d.log.warn('geoip: falla del proveedor', { error: (e as Error).name });
        return null;
      });
      porRed.set(red, p);
    }
    return p;
  };

  const items = [];
  for (const e of pendientes) {
    const red = truncarIp(e.ip);
    const geo = red ? await resolver(red) : null;
    if (util(geo)) resumen.resueltos++;
    else resumen.sin_dato++;
    items.push({ eventId: e.eventId, creadoEn: e.creadoEn, geo: util(geo) ? geo : null });
  }
  await d.repo.fijar(items);
  d.log.info('geoip: lote', { ...resumen });
  return resumen;
}
