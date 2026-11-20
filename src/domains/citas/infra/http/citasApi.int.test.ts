/** Handler citas-api (GET slots): validación Zod, CORS, rate limit, hora local + UTC (C9, NFR-SEG). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearVacante } from '@test/db/fixtures';
import { crearHandlerCitasApi } from './citasApi.ts';
import { crearLimitadorMemoria } from './limitador.ts';

const ORIGEN = 'https://369capitalhumano.com';
let db: TestDb;
let clock: FixedClock;
let lineas: string[];
beforeEach(async () => {
  db = await crearTestDb();
  clock = new FixedClock(new Date('2026-11-17T02:00:00Z'));
  lineas = [];
}, 120_000);
afterEach(async () => { await db?.close(); });

const handler = (max = 100) =>
  crearHandlerCitasApi({
    sql: db.servicio,
    clock,
    allowedOrigin: ORIGEN,
    limitador: crearLimitadorMemoria({ max, ventanaMs: 60_000, clock }),
    sink: (l) => lineas.push(l),
  });
const get = (qs: string, headers: Record<string, string> = {}) =>
  new Request(`https://x.supabase.co/functions/v1/citas-api${qs}`, { headers: { origin: ORIGEN, 'cf-connecting-ip': '189.203.1.2', ...headers } });

describe('GET /citas-api', () => {
  it('C9 · devuelve slots en hora local de la vacante y en UTC, con CORS', async () => {
    await crearVacante(db.sql, { slug: 'agente-smart' });
    const res = await handler()(get('?vacante=agente-smart'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
    const body = (await res.json()) as { zona_horaria: string; reglas_version: number; slots: Array<Record<string, unknown>> };
    expect(body.zona_horaria).toBe('America/Mexico_City');
    expect(body.reglas_version).toBe(0);
    expect(body.slots[0]).toEqual({
      inicio_utc: '2026-11-17T15:30:00.000Z',
      fin_utc: '2026-11-17T17:00:00.000Z',
      inicio_local: '2026-11-17T09:30:00-06:00',
      fecha: '2026-11-17',
      hora_local: '09:30',
      disponibles: 1,
    });
  });

  it('F7.4 · expone agenda_modo: sistema con slots; whatsapp sin slots y con el modo explícito', async () => {
    const { vacanteId } = await crearVacante(db.sql, { slug: 'por-whatsapp' });
    await crearVacante(db.sql, { slug: 'por-sistema' });
    await db.sql.query(`update shared.vacantes set agenda_modo = 'whatsapp' where id = $1`, [vacanteId]);
    const wa = (await (await handler()(get('?vacante=por-whatsapp'))).json()) as { agenda_modo: string; slots: unknown[] };
    expect(wa).toMatchObject({ vacante_id: vacanteId, agenda_modo: 'whatsapp', slots: [] });
    const sis = (await (await handler()(get('?vacante=por-sistema'))).json()) as { agenda_modo: string; slots: unknown[] };
    expect(sis.agenda_modo).toBe('sistema');
    expect(sis.slots.length).toBeGreaterThan(0);
  });

  it('acepta el id de la vacante', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const res = await handler()(get(`?vacante=${vacanteId}`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { vacante_id: string }).vacante_id).toBe(vacanteId);
  });

  it.each([['', 400], ['?vacante=', 400], ['?vacante=Agente%20Smart', 400], [`?vacante=${'a'.repeat(100)}`, 400], ['?vacante=no-existe', 404]])(
    'valida la consulta %s → %i',
    async (qs, status) => {
      const res = await handler()(get(qs));
      expect(res.status).toBe(status);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    },
  );

  it('OPTIONS → 204 con CORS; métodos distintos de GET → 405', async () => {
    const pre = await handler()(new Request('https://x/citas-api', { method: 'OPTIONS', headers: { origin: ORIGEN } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
    const post = await handler()(new Request('https://x/citas-api', { method: 'POST', headers: { origin: ORIGEN } }));
    expect(post.status).toBe(405);
  });

  it('origen no permitido → 403', async () => {
    const res = await handler()(get('?vacante=a', { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
  });

  it('rate limit por IP → 429 con retry-after', async () => {
    await crearVacante(db.sql, { slug: 'a' });
    const h = handler(2);
    expect((await h(get('?vacante=a'))).status).toBe(200);
    expect((await h(get('?vacante=a'))).status).toBe(200);
    const r = await h(get('?vacante=a'));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h(get('?vacante=a', { 'cf-connecting-ip': '10.0.0.9' }))).status).toBe(200);
  });

  it('error interno → 500 genérico y log sin PII', async () => {
    const roto = crearHandlerCitasApi({
      sql: { query: async () => { throw new Error('conexión caída a 189.203.1.2'); }, transaction: async () => { throw new Error('x'); } },
      clock,
      allowedOrigin: ORIGEN,
      sink: (l) => lineas.push(l),
    });
    const res = await roto(get('?vacante=a'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'ERROR_INTERNO' });
    expect(lineas.join('\n')).not.toContain('189.203.1.2');
  });
});
