/** TRK-07 · SQL del enriquecimiento geográfico asíncrono: candidatos y escritura en lote (solo service_role). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearLogger } from '@shared/logger.ts';
import { enriquecerGeo } from '../../application/enriquecer-geo.ts';
import { crearRepoGeoSql } from './geo.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000);
afterEach(async () => { await db.close(); });

async function evento(id: string, o: { ip?: string | null; ciudad?: string | null; consentimiento?: boolean; creado?: string } = {}) {
  const consent = o.consentimiento ?? true;
  await db.sql.query(
    `insert into tracking.eventos (event_id, creado_en, nombre, fuente, consentimiento, cliente_id, ip, ciudad)
     values ($1, $2, 'PageView', 'navegador', $3, '00000000-0000-0000-0000-000000000000', $4::inet, $5)`,
    [id, o.creado ?? new Date(Date.now() - 60_000).toISOString(), consent, consent ? (o.ip === undefined ? '189.203.1.2' : o.ip) : null, o.ciudad ?? null]);
}
const id = (n: number) => `01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d${String(n).padStart(2, '0')}`;

describe('tracking.eventos_sin_geo / tracking.fijar_geo', () => {
  it('candidatos: con consentimiento, IP completa, sin ciudad ni intento previo y de los últimos 7 días', async () => {
    await evento(id(1));                                        // candidato
    await evento(id(2), { ciudad: 'Monterrey' });               // ya trae ciudad del CDN
    await evento(id(3), { consentimiento: false });             // sin IP
    await evento(id(4), { creado: new Date(Date.now() - 8 * 86_400_000).toISOString() }); // > 7 días
    const repo = crearRepoGeoSql(db.servicio);
    expect((await repo.pendientes(10)).map((e) => [e.eventId, e.ip])).toEqual([[id(1), '189.203.1.2']]);
  });

  it('fijar escribe solo ciudad/región/país, nunca pisa un dato del CDN y marca el intento aunque no haya dato', async () => {
    await evento(id(1));
    await evento(id(2), { ip: '8.8.8.8' });
    const repo = crearRepoGeoSql(db.servicio);
    const geo = { geoIp: { resolver: async (ip: string) => (ip === '189.203.1.0' ? { ciudad: 'Monterrey', region: 'Nuevo León', pais: 'MX' } : null) } };
    expect(await enriquecerGeo({ repo, ...geo, log: crearLogger({}, () => {}) })).toMatchObject({ resueltos: 1, sin_dato: 1 });
    const { rows } = await db.sql.query<Record<string, unknown>>(`select event_id, ciudad, region, pais, geo_intentado, host(ip) as ip from tracking.eventos order by event_id`);
    expect(rows).toEqual([
      { event_id: id(1), ciudad: 'Monterrey', region: 'Nuevo León', pais: 'MX', geo_intentado: true, ip: '189.203.1.2' },
      { event_id: id(2), ciudad: null, region: null, pais: null, geo_intentado: true, ip: '8.8.8.8' },
    ]);
    expect(await repo.pendientes(10)).toEqual([]);
    // fijar sobre un evento con ciudad del CDN no la cambia
    await evento(id(3), { ciudad: 'Saltillo' });
    const { rows: [e3] } = await db.sql.query<{ creado_en: Date }>(`select creado_en from tracking.eventos where event_id = $1`, [id(3)]);
    await repo.fijar([{ eventId: id(3), creadoEn: new Date(e3!.creado_en).toISOString(), geo: { ciudad: 'Otra', region: 'X', pais: 'US' } }]);
    expect((await db.sql.query(`select ciudad, pais from tracking.eventos where event_id = $1`, [id(3)])).rows).toEqual([{ ciudad: 'Saltillo', pais: null }]);
  });

  it('regresión (hallada en Postgres real): creado_en con microsegundos sobrevive la ida y vuelta y se actualiza', async () => {
    await evento(id(1), { creado: new Date(Date.now() - 60_000).toISOString().replace(/Z$/, '').replace(/(\.\d{3})$/, '$1456Z') });
    const repo = crearRepoGeoSql(db.servicio);
    const [p] = await repo.pendientes(1);
    expect(p!.creadoEn).toMatch(/\.\d{6}/);
    expect(await repo.fijar([{ eventId: p!.eventId, creadoEn: p!.creadoEn, geo: { ciudad: 'León', region: null, pais: 'MX' } }])).toBe(1);
    expect(await repo.pendientes(1)).toEqual([]);
  });

  it('valida longitudes y país ISO-2 en SQL; anon/authenticated no ejecutan las funciones', async () => {
    await evento(id(1));
    const repo = crearRepoGeoSql(db.servicio);
    const [p] = await repo.pendientes(1);
    await repo.fijar([{ eventId: p!.eventId, creadoEn: p!.creadoEn, geo: { ciudad: 'C'.repeat(150), region: null, pais: 'Mexico' } }]);
    expect((await db.sql.query(`select length(ciudad) as n, pais from tracking.eventos`)).rows).toEqual([{ n: 100, pais: null }]);
    await expect(db.como('anon', null, (s) => s.query(`select * from tracking.eventos_sin_geo(1)`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario('00000000-0000-4000-8000-000000000001', (s) => s.query(`select tracking.fijar_geo('[]'::jsonb)`))).rejects.toThrow(/permission denied/);
  });
});
