import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearVacante } from '../../../../../test/db/fixtures.ts';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerIngest } from './ingest.ts';
import { crearLimitadorMemoria } from './limitador.ts';
import { crearRepoTrackingSql } from '../sql/repositorio.ts';

const ORIGEN = 'https://capitalhumano369.com';
const EID = '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e';
const VID = '01934f6e-0000-7000-8000-000000000001';
let db: TestDb;
let handler: (r: Request) => Promise<Response>;
let logs: string[];

beforeEach(async () => {
  db = await crearTestDb();
  logs = [];
  handler = crearHandlerIngest({
    repo: crearRepoTrackingSql(db.servicio),
    origenesPermitidos: [ORIGEN],
    limitador: crearLimitadorMemoria({ max: 5, ventanaMs: 60_000 }, new FixedClock(new Date('2026-11-13T18:00:00Z'))),
    log: crearLogger({}, (l) => logs.push(l)),
    hostPropio: 'capitalhumano369.com',
  });
}, 60_000);
afterEach(async () => { await db.close(); });

const cuerpo = (extra: Record<string, unknown> = {}) => ({
  v: 1, event_id: EID, nombre: 'PageView', consentimiento: true, visitor_id: VID, pagina: '/vacantes/agente-smart/',
  atribucion: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'nov', fbclid: 'IwAR1', fbc: 'fb.1.1700000000000.IwAR1', fbp: 'fb.1.1700000000000.42' },
  custom_data: { vacancy_id: 'agente-smart', content_category: 'ventas' }, ...extra,
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request('https://f.test/tracking-ingest', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { origin: ORIGEN, 'content-type': 'text/plain;charset=UTF-8', 'x-forwarded-for': '189.203.1.2, 10.0.0.1', 'user-agent': 'Mozilla/5.0', 'cf-ipcity': 'Monterrey', 'cf-ipcountry': 'MX', ...headers },
  }));

describe('tracking-ingest (handler + PGlite)', () => {
  it('T3 · el mismo event_id dos veces → 1 fila y 1 mensaje por destino', async () => {
    const { vacanteId } = await crearVacante(db.sql, { slug: 'agente-smart' });
    expect((await post(cuerpo())).status).toBe(202);
    const r2 = await post(cuerpo());
    expect(r2.status).toBe(202);
    expect(await r2.json()).toEqual({ ok: true, registro: 'duplicado' });
    const { rows } = await db.sql.query<Record<string, unknown>>(`select host(ip) as ip, ciudad, pais, user_agent, origen, vacante_id, fbc from tracking.eventos`);
    expect(rows).toEqual([{ ip: '189.203.1.2', ciudad: 'Monterrey', pais: 'MX', user_agent: 'Mozilla/5.0', origen: 'meta_pagado', vacante_id: vacanteId, fbc: 'fb.1.1700000000000.IwAR1' }]);
    const cola = await db.sql.query(`select 1 from shared.cola where cola = 'tracking-capi'`);
    expect(cola.rows).toHaveLength(2);
  });

  it('TRK-08 · client_id y vacancy_id salen de la vacante (shared.api_vacante_por_slug); el client_id del navegador se ignora', async () => {
    const vac = await crearVacante(db.sql, { slug: 'agente-smart' });
    const otro = await crearVacante(db.sql, { slug: 'otra-vacante' });
    // slug conocido + client_id de OTRO cliente existente → el de la vacante
    expect((await post(cuerpo({ custom_data: { vacancy_id: 'agente-smart', client_id: otro.clienteId, content_category: 'ventas' } }))).status).toBe(202);
    // slug desconocido + client_id existente → no se confía en el navegador: cliente nulo del proyecto
    expect((await post(cuerpo({ event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0f', custom_data: { vacancy_id: 'no-existe', client_id: otro.clienteId } }))).status).toBe(202);
    // sin consentimiento (conteo anónimo) tampoco
    expect((await post(cuerpo({ consentimiento: false, visitor_id: undefined, atribucion: {}, custom_data: { vacancy_id: 'no-existe', client_id: otro.clienteId } }))).status).toBe(202);
    const { rows } = await db.sql.query<{ event_id: string; vacante_id: string | null; cliente_id: string }>(`select event_id, vacante_id, cliente_id from tracking.eventos order by event_id`);
    expect(rows).toEqual([
      { event_id: EID, vacante_id: vac.vacanteId, cliente_id: vac.clienteId },
      { event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0f', vacante_id: null, cliente_id: '00000000-0000-0000-0000-000000000000' },
    ]);
    const anon = await db.sql.query<{ cliente_id: string }>(`select cliente_id from tracking.agregados_diarios`);
    expect(anon.rows).toEqual([{ cliente_id: '00000000-0000-0000-0000-000000000000' }]);
  });

  it('CORS: preflight permitido, origen ajeno rechazado, métodos no POST', async () => {
    const pre = await handler(new Request('https://f.test/x', { method: 'OPTIONS', headers: { origin: ORIGEN } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    expect((await handler(new Request('https://f.test/x', { method: 'OPTIONS', headers: { origin: 'https://malo.com' } }))).status).toBe(403);
    const ajeno = await post(cuerpo(), { origin: 'https://malo.com' });
    expect(ajeno.status).toBe(403);
    expect(ajeno.headers.get('access-control-allow-origin')).toBeNull();
    expect((await handler(new Request('https://f.test/x', { method: 'GET', headers: { origin: ORIGEN } }))).status).toBe(405);
  });

  it('rechaza JSON inválido, payload fuera de contrato y cuerpos grandes sin filtrar detalles', async () => {
    expect((await post('{no json')).status).toBe(400);
    const r = await post(cuerpo({ nombre: 'Schedule' }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'INVALIDO' });
    expect((await post('x'.repeat(9000))).status).toBe(413);
    expect((await post(cuerpo(), { 'content-length': '99999' })).status).toBe(413);
  });

  it('rate limit por IP → 429', async () => {
    const estados: number[] = [];
    for (let i = 0; i < 6; i++) estados.push((await post(cuerpo({ event_id: `01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d1${i}` }))).status);
    expect(estados).toEqual([202, 202, 202, 202, 202, 429]);
    expect((await post(cuerpo(), { 'x-forwarded-for': '200.1.1.1' })).status).toBe(202);
  });

  it('sin consentimiento: 202, solo conteo; no queda IP, UA ni visitor en ninguna tabla', async () => {
    const r = await post({ v: 1, event_id: EID, nombre: 'PageView', consentimiento: false, pagina: '/', atribucion: { utm_source: 'google', utm_medium: 'cpc' } });
    expect(await r.json()).toEqual({ ok: true, registro: 'anonimo' });
    expect((await db.sql.query(`select 1 from tracking.eventos`)).rows).toHaveLength(0);
    expect((await db.sql.query(`select 1 from shared.cola`)).rows).toHaveLength(0);
    const { rows } = await db.sql.query(`select origen, n::int as n from tracking.agregados_diarios`);
    expect(rows).toEqual([{ origen: 'google_pagado', n: 1 }]);
  });

  it('error interno → 500 sin detalles y log redactado', async () => {
    await db.sql.query(`revoke execute on function tracking.registrar_evento(jsonb, text[]) from service_role`);
    const r = await post(cuerpo());
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'INTERNO' });
    expect(logs.join()).toContain('tracking-ingest: error');
  });
});
