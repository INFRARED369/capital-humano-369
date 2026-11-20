import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { construirEventoGa4, construirEventoMeta } from '../../domain/capi.ts';
import { Ga4MpRequestSchema, MetaCapiErrorSchema, MetaCapiRequestSchema, MetaCapiRespuestaSchema } from './contratos.ts';
import { crearMetaCapiAdapter } from './meta-capi.ts';
import { crearGa4Adapter } from './ga4.ts';
import { crearContactosDesdeCaptacion } from './contactos.ts';

const fixture = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8'));
const metaReq = fixture('meta-capi-request.json');
const ga4Req = fixture('ga4-mp-request.json');

describe('contratos (fixtures grabados)', () => {
  it('fixtures válidos', () => {
    expect(MetaCapiRequestSchema.safeParse(metaReq).success).toBe(true);
    expect(MetaCapiRespuestaSchema.safeParse(fixture('meta-capi-respuesta-ok.json')).success).toBe(true);
    expect(MetaCapiErrorSchema.safeParse(fixture('meta-capi-respuesta-error.json')).success).toBe(true);
    expect(Ga4MpRequestSchema.safeParse(ga4Req).success).toBe(true);
  });
  it('NFR-SEG-04 · el contrato rechaza PII en claro y custom_data sin client_id', () => {
    const conPii = structuredClone(metaReq);
    conPii.data[0].user_data.ph = ['528112345678'];
    expect(MetaCapiRequestSchema.safeParse(conPii).success).toBe(false);
    const conEmail = structuredClone(metaReq);
    conEmail.data[0].user_data.email = 'a@b.c';
    expect(MetaCapiRequestSchema.safeParse(conEmail).success).toBe(false);
    const sinCliente = structuredClone(metaReq);
    delete sinCliente.data[0].custom_data.client_id;
    expect(MetaCapiRequestSchema.safeParse(sinCliente).success).toBe(false);
  });
  it('lo que construye el dominio cumple el contrato', async () => {
    const ev = await construirEventoMeta({
      eventId: 'e1', nombreMeta: 'Schedule', actionSource: 'website', ocurridoEn: new Date(), urlOrigen: 'https://x.mx/', customData: { vacancy_id: 'v', client_id: 'c', content_category: null },
      contacto: { telefono: '8112345678', email: null, nombrePila: 'Ana' }, visitante: { visitorId: 'vid', ip: '1.2.3.4', userAgent: 'UA', fbc: null, fbp: null },
    });
    expect(MetaCapiRequestSchema.safeParse({ data: [ev] }).success).toBe(true);
    expect(Ga4MpRequestSchema.safeParse(construirEventoGa4({ nombre: 'schedule_interview', clientId: 'vid', eventId: 'e1', ocurridoEn: new Date(), customData: { client_id: 'c' } })).success).toBe(true);
  });
});

const respuesta = (status: number, body: unknown = {}) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));

describe('MetaCapiPort', () => {
  it('T5 · directo: un solo pixel_id en la URL y token en el cuerpo (no en la URL)', async () => {
    const f = vi.fn(() => respuesta(200, fixture('meta-capi-respuesta-ok.json')));
    const r = await crearMetaCapiAdapter({ pixelId: '111222333', token: 'tok' }, f).enviar(metaReq);
    expect(r).toEqual({ ok: true, value: { eventosRecibidos: 1 } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/111222333/events');
    expect(url).not.toContain('tok');
    expect(JSON.parse(init.body as string)).toMatchObject({ access_token: 'tok', data: metaReq.data });
  });
  it('vía Stape: Data Client con pixel_id y sin token', async () => {
    const f = vi.fn(() => respuesta(200));
    await crearMetaCapiAdapter({ pixelId: '111222333', stapeUrl: 'https://sgtm.capitalhumano369.com/' }, f).enviar(metaReq);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sgtm.capitalhumano369.com/data');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ event_name: 'meta_capi', pixel_id: '111222333' });
    expect(body).not.toHaveProperty('access_token');
  });
  it('clasifica errores: 500/429/red reintentables; 400 y payload fuera de contrato no', async () => {
    const a = crearMetaCapiAdapter({ pixelId: '111222333', token: 't' }, () => respuesta(500));
    expect(await a.enviar(metaReq)).toMatchObject({ ok: false, error: { reintentable: true, status: 500 } });
    const b = crearMetaCapiAdapter({ pixelId: '111222333', token: 't' }, () => respuesta(400, fixture('meta-capi-respuesta-error.json')));
    expect(await b.enviar(metaReq)).toMatchObject({ ok: false, error: { reintentable: false, status: 400 } });
    const c = crearMetaCapiAdapter({ pixelId: '111222333', token: 't' }, () => respuesta(429));
    expect(await c.enviar(metaReq)).toMatchObject({ ok: false, error: { reintentable: true } });
    const d = crearMetaCapiAdapter({ pixelId: '111222333', token: 't' }, () => Promise.reject(new TypeError('fetch failed')));
    expect(await d.enviar(metaReq)).toMatchObject({ ok: false, error: { reintentable: true } });
    expect(await d.enviar({ data: [] })).toMatchObject({ ok: false, error: { reintentable: false } });
    const e = crearMetaCapiAdapter({ pixelId: '111222333', token: 't' }, () => respuesta(200, { raro: 1 }));
    expect(await e.enviar(metaReq)).toMatchObject({ ok: false, error: { reintentable: true } });
  });
  it('configuración inválida falla al arrancar', () => {
    expect(() => crearMetaCapiAdapter({ pixelId: 'abc', token: 't' })).toThrow();
    expect(() => crearMetaCapiAdapter({ pixelId: '111222333' })).toThrow();
  });
});

describe('Ga4Port', () => {
  it('directo y vía Stape (/mp/collect) con measurement_id y api_secret', async () => {
    const f = vi.fn(() => respuesta(204));
    expect(await crearGa4Adapter({ measurementId: 'G-ABC123', apiSecret: 's' }, f).enviar(ga4Req)).toEqual({ ok: true, value: undefined });
    await crearGa4Adapter({ measurementId: 'G-ABC123', apiSecret: 's', stapeUrl: 'https://sgtm.x.mx' }, f).enviar(ga4Req);
    expect((f.mock.calls as unknown as [string][]).map((c) => c[0])).toEqual([
      'https://www.google-analytics.com/mp/collect?measurement_id=G-ABC123&api_secret=s',
      'https://sgtm.x.mx/mp/collect?measurement_id=G-ABC123&api_secret=s',
    ]);
    expect(await crearGa4Adapter({ measurementId: 'G-ABC123', apiSecret: 's' }, () => respuesta(503)).enviar(ga4Req)).toMatchObject({ ok: false, error: { reintentable: true } });
    expect(await crearGa4Adapter({ measurementId: 'G-ABC123', apiSecret: 's' }, f).enviar({ ...ga4Req, events: [] })).toMatchObject({ ok: false });
    expect(() => crearGa4Adapter({ measurementId: 'UA-1', apiSecret: 's' })).toThrow();
    expect(() => crearGa4Adapter({ measurementId: 'G-ABC123', apiSecret: '' })).toThrow();
  });
});

describe('ContactosPort ← captacion.obtenerContactoLead', () => {
  it('expone solo teléfono, correo y nombre de pila', async () => {
    const obtener = vi.fn(async () => ({ telefonoE164: '+528112345678', email: null, nombrePila: 'Ana', folio: 'A1', visitorId: null, vacanteId: 'v', clienteId: 'c' }));
    const p = crearContactosDesdeCaptacion(obtener, {} as never);
    expect(await p.obtener('l1')).toEqual({ telefonoE164: '+528112345678', email: null, nombrePila: 'Ana' });
    const q = crearContactosDesdeCaptacion(async () => null, {} as never);
    expect(await q.obtener('l1')).toBeNull();
  });
});
