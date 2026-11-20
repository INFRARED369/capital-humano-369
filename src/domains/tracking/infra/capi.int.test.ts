/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON de proveedores en aserciones */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearVacante } from '../../../../test/db/fixtures.ts';
import { sha256Hex } from '@shared/crypto.ts';
import { crearLogger } from '@shared/logger.ts';
import { correrTrabajoTracking, crearHandlerWorker } from './http/worker.ts';
import { crearMetaCapiAdapter } from './proveedores/meta-capi.ts';
import { crearGa4Adapter } from './proveedores/ga4.ts';
import { crearRepoTrackingSql } from './sql/repositorio.ts';

const PIXEL = '111222333';
const META_URL = `https://graph.facebook.com/v21.0/${PIXEL}/events`;
const GA4_URL = 'https://www.google-analytics.com/mp/collect';
const VID = '01934f6e-0000-7000-8000-000000000001';
const LEAD = '01934f6e-aaaa-7000-8000-000000000001';
const E_LEAD = '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e';

const metaRecibidos: Array<{ url: string; body: Record<string, any> }> = [];
const ga4Recibidos: unknown[] = [];
let metaStatus: number[] = [];
const server = setupServer(
  http.post(META_URL, async ({ request }) => {
    metaRecibidos.push({ url: request.url, body: (await request.json()) as Record<string, any> });
    const s = metaStatus.shift() ?? 200;
    return s === 200 ? HttpResponse.json({ events_received: 1, messages: [], fbtrace_id: 'x' }) : HttpResponse.json({ error: { message: 'boom' } }, { status: s });
  }),
  http.post(GA4_URL, async ({ request }) => {
    ga4Recibidos.push(await request.json());
    return new HttpResponse(null, { status: 204 });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

let db: TestDb;
let vac: { vacanteId: string; clienteId: string };
beforeEach(async () => {
  db = await crearTestDb();
  metaRecibidos.length = 0;
  ga4Recibidos.length = 0;
  metaStatus = [];
  vac = await crearVacante(db.sql, { slug: 'agente-smart' });
}, 60_000);
afterEach(async () => { await db.close(); });

const deps = () => ({
  sql: db.servicio,
  meta: crearMetaCapiAdapter({ pixelId: PIXEL, token: 'tok' }),
  ga4: crearGa4Adapter({ measurementId: 'G-TEST123', apiSecret: 'sec' }),
  contactos: { obtener: async (id: string) => (id === LEAD ? { telefonoE164: '+528112345678', email: null, nombrePila: 'Ana' } : null) },
  config: { sitioUrl: 'https://capitalhumano369.com' },
  log: crearLogger({}, () => {}),
});
const publicar = (tipo: string, payload: Record<string, unknown>) =>
  db.sql.query(`select shared.publicar_evento($1, $2::jsonb, $3)`, [tipo, JSON.stringify(payload), vac.clienteId]);
const visitaPrevia = () => crearRepoTrackingSql(db.servicio).registrarEvento({
  event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d00', nombre: 'PageView', fuente: 'navegador', consentimiento: true, visitor_id: VID, origen: 'meta_pagado',
  vacante_ref: 'agente-smart', ip: '189.203.1.2', user_agent: 'Mozilla/5.0', fbc: 'fb.1.1700000000000.IwAR1', fbp: 'fb.1.1700000000000.42', pagina: '/vacantes/agente-smart/', utm_campaign: 'nov',
}, []);
const visibles = () => db.sql.query(`update shared.cola set visible_desde = now() where cola = 'tracking-capi'`);

describe('outbox → cola tracking-capi → Meta CAPI / GA4 (PGlite + MSW)', () => {
  it('T5 · LeadCreado: Lead con el mismo event_id del Pixel, un solo pixel, custom_data y ph hasheado', async () => {
    await visitaPrevia();
    await publicar('LeadCreado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, folio: 'A1', event_id: E_LEAD, visitor_id: VID, origen: 'meta_pagado' });
    const r = await correrTrabajoTracking(deps());
    expect(r).toEqual({ outbox: { procesados: 1 }, capi: { enviados: 2, reintentos: 0, deadLetters: 0, omitidos: 0 } });
    expect(metaRecibidos).toHaveLength(1);
    expect(new Set(metaRecibidos.map((m) => new URL(m.url).pathname))).toEqual(new Set([`/v21.0/${PIXEL}/events`]));
    const ev = metaRecibidos[0]!.body.data[0];
    expect(ev).toMatchObject({ event_name: 'Lead', event_id: E_LEAD, event_source_url: 'https://capitalhumano369.com/vacantes/agente-smart/' });
    expect(ev.user_data).toMatchObject({ ph: [await sha256Hex('528112345678')], client_ip_address: '189.203.1.2', fbc: 'fb.1.1700000000000.IwAR1' });
    expect(ev.custom_data).toEqual({ vacancy_id: vac.vacanteId, client_id: vac.clienteId });
    expect(JSON.stringify(metaRecibidos)).not.toContain('8112345678"');
    expect(ga4Recibidos).toHaveLength(1);
  });

  it('TRK-07 · con GeoIpPort el worker completa ciudad/región/país del evento sin dato del CDN (asíncrono, red /24)', async () => {
    await visitaPrevia();
    const consultadas: string[] = [];
    const geoIp = { resolver: async (ip: string) => { consultadas.push(ip); return { ciudad: 'Monterrey', region: 'Nuevo León', pais: 'MX' }; } };
    const r = await correrTrabajoTracking({ ...deps(), geoIp });
    expect(r).toMatchObject({ geo: { pendientes: 1, consultas: 1, resueltos: 1, sin_dato: 0 } });
    expect(consultadas).toEqual(['189.203.1.0']);
    const { rows } = await db.sql.query(`select ciudad, region, pais, host(ip) as ip from tracking.eventos`);
    expect(rows).toEqual([{ ciudad: 'Monterrey', region: 'Nuevo León', pais: 'MX', ip: '189.203.1.2' }]);
    expect((await correrTrabajoTracking({ ...deps(), geoIp })).geo).toMatchObject({ pendientes: 0 });
  });

  it('T8 + E2E-01 · Schedule solo tras CitaConfirmada (post-OTP); T6 asistencia offline system_generated', async () => {
    await visitaPrevia();
    await publicar('LeadCreado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, folio: 'A1', event_id: E_LEAD, visitor_id: VID, origen: 'meta_pagado' });
    await publicar('WhatsAppVerificado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d10' });
    await correrTrabajoTracking(deps());
    expect(metaRecibidos.map((m) => m.body.data[0].event_name)).toEqual(['Lead']);
    await publicar('CitaConfirmada', { cita_id: 'c', lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, inicio: 'i', fin: 'f', folio: 'A1', nombre_pila: 'Ana', reglas_version: 1, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d11' });
    await publicar('AsistenciaRegistrada', { cita_id: 'c', lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, asistio: true, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d12' });
    await correrTrabajoTracking(deps());
    expect(metaRecibidos.map((m) => m.body.data[0].event_name)).toEqual(['Lead', 'Schedule', 'CompleteRegistration']);
    const schedule = metaRecibidos[1]!.body.data[0];
    expect(schedule.custom_data.vacancy_id).toBe(vac.vacanteId);
    expect(schedule.user_data.fbp).toBe('fb.1.1700000000000.42');
    expect(metaRecibidos[2]!.body.data[0].action_source).toBe('system_generated');
    // re-correr no reenvía nada (cursor + dedupe + cola idempotente)
    await correrTrabajoTracking(deps());
    expect(metaRecibidos).toHaveLength(3);
  });

  it('TRK-09 · LeadContratado (dashboard.registrar_contratacion) → `Contratado` offline system_generated, una sola vez', async () => {
    await visitaPrevia();
    await publicar('LeadCreado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, folio: 'A1', event_id: E_LEAD, visitor_id: VID, origen: 'meta_pagado' });
    const cita = '33333333-3333-4333-8333-333333333333';
    await publicar('LeadContratado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, cita_id: cita, entregado_en: null, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d14' });
    await correrTrabajoTracking(deps());
    await publicar('LeadContratado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, cita_id: cita, entregado_en: '2026-11-20T10:00:00.000Z', event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d15' });
    await correrTrabajoTracking(deps());
    expect(metaRecibidos.map((m) => m.body.data[0].event_name)).toEqual(['Lead', 'Contratado']);
    const ev = metaRecibidos[1]!.body.data[0];
    expect(ev).toMatchObject({ action_source: 'system_generated', custom_data: { vacancy_id: vac.vacanteId, client_id: vac.clienteId } });
    expect(ev.event_source_url).toBeUndefined();
    expect(ev.user_data.ph).toEqual([await sha256Hex('528112345678')]);
  });

  it('TRK-08 · el worker deriva client_id de la vacante (shared.api_vacante_por_slug), no del valor guardado', async () => {
    await visitaPrevia();
    // fila heredada con un cliente que no es el de la vacante (p. ej. client_id de texto del JSON de contenido)
    await db.sql.query(`update tracking.eventos set cliente_id = '00000000-0000-0000-0000-000000000000'`);
    await db.sql.query(`select shared.encolar('tracking-capi', $1::jsonb, 'meta:x', 5::smallint, $2)`,
      [JSON.stringify({ destino: 'meta', event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d00' }), vac.clienteId]);
    await correrTrabajoTracking(deps());
    expect(metaRecibidos).toHaveLength(1);
    expect(metaRecibidos[0]!.body.data[0].custom_data).toEqual({ vacancy_id: vac.vacanteId, client_id: vac.clienteId });
  });

  it('T7 · CAPI 500 → reintento sin pérdida; agotados los intentos → dead letter', async () => {
    await visitaPrevia();
    await publicar('LeadCreado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, folio: 'A1', event_id: E_LEAD, visitor_id: VID, origen: 'meta_pagado' });
    metaStatus = [500];
    expect((await correrTrabajoTracking(deps())).capi).toMatchObject({ reintentos: 1 });
    const { rows: [m] } = await db.sql.query<{ estado: string; intentos: number }>(`select estado, intentos from shared.cola where llave_idempotencia = $1`, [`meta:${E_LEAD}`]);
    expect(m).toEqual({ estado: 'pendiente', intentos: 1 });
    await visibles();
    expect((await correrTrabajoTracking(deps())).capi).toMatchObject({ enviados: 1 });
    expect(metaRecibidos).toHaveLength(2);
    expect(metaRecibidos[1]!.body.data).toEqual(metaRecibidos[0]!.body.data);

    await publicar('CitaConfirmada', { cita_id: 'c', lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, inicio: 'i', fin: 'f', folio: 'A1', nombre_pila: 'Ana', reglas_version: 1, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d11' });
    metaStatus = [500, 500, 500, 500, 500];
    for (let i = 0; i < 5; i++) {
      await correrTrabajoTracking(deps());
      await visibles();
    }
    const dl = await db.sql.query<{ payload: Record<string, string> }>(`select payload from shared.dead_letter where cola = 'tracking-capi'`);
    expect(dl.rows).toHaveLength(1);
    expect(dl.rows[0]!.payload.destino).toBe('meta');
  });

  it('lead suprimido antes del envío → no se envía nada a Meta', async () => {
    await visitaPrevia();
    await publicar('LeadCreado', { lead_id: LEAD, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, folio: 'A1', event_id: E_LEAD, visitor_id: VID, origen: 'meta_pagado' });
    const d = deps();
    const sinWorker = { ...d, meta: { enviar: async () => { throw new Error('no debe llamarse aún'); } } };
    expect((await correrTrabajoTracking(sinWorker)).capi.reintentos).toBe(1); // Meta caído en el primer intento
    await db.sql.query(`select tracking.suprimir_lead($1)`, [LEAD]);
    await visibles();
    const r = await correrTrabajoTracking(d);
    expect(metaRecibidos).toHaveLength(0);
    expect(r.capi.enviados).toBe(0);
  });
});

describe('handler tracking-capi-worker', () => {
  it('exige el secreto con Bearer y solo POST', async () => {
    const h = crearHandlerWorker({ secreto: 's'.repeat(32), correr: async () => ({ capi: { enviados: 0 } }), log: crearLogger({}, () => {}) });
    expect((await h(new Request('https://f/x', { method: 'GET' }))).status).toBe(405);
    expect((await h(new Request('https://f/x', { method: 'POST', headers: { authorization: 'Bearer x' } }))).status).toBe(401);
    const ok = await h(new Request('https://f/x', { method: 'POST', headers: { authorization: `Bearer ${'s'.repeat(32)}` } }));
    expect(await ok.json()).toEqual({ ok: true, capi: { enviados: 0 } });
    const falla = crearHandlerWorker({ secreto: 's'.repeat(32), correr: async () => { throw new Error('x'); }, log: crearLogger({}, () => {}) });
    expect((await falla(new Request('https://f/x', { method: 'POST', headers: { authorization: `Bearer ${'s'.repeat(32)}` } }))).status).toBe(500);
    expect(() => crearHandlerWorker({ secreto: 'corto', correr: async () => ({}), log: crearLogger({}, () => {}) })).toThrow();
  });
});
