import { describe, expect, it } from 'vitest';
import { crearLogger } from '@shared/logger.ts';
import { enriquecerGeo } from './enriquecer-geo.ts';
import type { Geo, GeoIpPort, RepoGeoPort, EventoSinGeo } from './puertos.ts';

function repoGeo(pendientes: EventoSinGeo[]) {
  const fijados: { eventId: string; creadoEn: string; geo: Geo | null }[] = [];
  const repo: RepoGeoPort = {
    pendientes: async (n) => pendientes.slice(0, n),
    fijar: async (items) => { fijados.push(...items); return items.length; },
  };
  return { repo, fijados };
}

const ev = (id: string, ip: string): EventoSinGeo => ({ eventId: id, creadoEn: '2026-11-17T18:00:00.000Z', ip });

describe('TRK-07 · enriquecerGeo (asíncrono, en el worker de tracking)', () => {
  it('consulta UNA vez por /24 (manda la red truncada, no la IP completa) y fija ciudad/región/país a cada evento', async () => {
    const consultas: string[] = [];
    const geoIp: GeoIpPort = { resolver: async (ip) => { consultas.push(ip); return { ciudad: 'Monterrey', region: 'NLE', pais: 'MX' }; } };
    const { repo, fijados } = repoGeo([ev('a', '189.203.1.2'), ev('b', '189.203.1.77'), ev('c', '2806:2f0:9a0:1::5')]);
    const r = await enriquecerGeo({ repo, geoIp, log: crearLogger({}, () => {}) });
    expect(consultas).toEqual(['189.203.1.0', '2806:2f0:9a0::']);
    expect(fijados.map((f) => [f.eventId, f.geo?.ciudad])).toEqual([['a', 'Monterrey'], ['b', 'Monterrey'], ['c', 'Monterrey']]);
    expect(r).toEqual({ pendientes: 3, consultas: 2, resueltos: 3, sin_dato: 0 });
  });

  it('proveedor sin dato o que lanza → se marca intentado (geo null) para no reintentar sin fin; IP inválida → null sin consultar', async () => {
    const geoIp: GeoIpPort = { resolver: async (ip) => { if (ip.startsWith('10.')) throw new Error('timeout'); return null; } };
    const { repo, fijados } = repoGeo([ev('a', '10.0.0.1'), ev('b', '8.8.8.8'), ev('c', 'basura')]);
    const r = await enriquecerGeo({ repo, geoIp, log: crearLogger({}, () => {}) });
    expect(fijados.map((f) => [f.eventId, f.geo])).toEqual([['a', null], ['b', null], ['c', null]]);
    expect(r).toMatchObject({ consultas: 2, resueltos: 0, sin_dato: 3 });
  });

  it('sin pendientes no consulta ni escribe', async () => {
    let n = 0;
    const { repo, fijados } = repoGeo([]);
    await enriquecerGeo({ repo, geoIp: { resolver: async () => { n++; return null; } }, log: crearLogger({}, () => {}) });
    expect(n).toBe(0);
    expect(fijados).toEqual([]);
  });
});
