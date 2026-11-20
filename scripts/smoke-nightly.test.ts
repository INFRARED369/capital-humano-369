/** §3.1 · Smoke nightly contra staging: Zoho (crear/borrar con contrato Zod), Evolution (existe + OTP), citas-api y tracking-ingest. */
import { describe, expect, it } from 'vitest';
import { crearZohoCalendarAdapter, construirEventoMinimo } from '../src/domains/citas/zoho/index.ts';
import { crearEvolutionAdapter } from '../src/domains/comunicacion/index.ts';
import { ejecutarSmoke, leerConfig, resumenMarkdown, type ConfigSmoke } from './smoke-nightly.mjs';

const dominio = { crearZohoCalendarAdapter, construirEventoMinimo, crearEvolutionAdapter };
const ENV = {
  ZOHO_DC: 'eu', ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'csec', ZOHO_REFRESH_TOKEN: 'rtok', ZOHO_CALENDARIO_PRUEBA: 'cal_smoke',
  EVOLUTION_URL: 'https://evo.staging.example', EVOLUTION_API_KEY: 'k', EVOLUTION_INSTANCE: 'inst', SMOKE_TELEFONO_PRUEBA: '8112345678',
  STAGING_FUNCIONES_URL: 'https://stg.supabase.co/functions/v1', STAGING_URL: 'https://staging.369capitalhumano.com',
};

const SLOTS_OK = {
  vacante_id: '0192f0a0-0000-7000-8000-000000000001', agenda_modo: 'sistema', zona_horaria: 'America/Mexico_City', reglas_version: 2,
  slots: [{ inicio_utc: '2026-11-18T15:30:00.000Z', fin_utc: '2026-11-18T17:00:00.000Z', inicio_local: '2026-11-18T09:30:00-06:00', fecha: '2026-11-18', hora_local: '09:30', disponibles: 1 }],
};

interface Llamada { metodo: string; url: string; headers: Record<string, string>; cuerpo: string }
/** fetch falso con estado: un calendario de Zoho en memoria, Evolution y las edge functions de staging. */
function fetchFalso(o: { zohoEvento?: Record<string, unknown>; slots?: unknown; ingestStatus?: number; existe?: boolean; tokenStatus?: number } = {}) {
  const llamadas: Llamada[] = [];
  const eventos = new Map<string, Record<string, unknown>>();
  const json = (status: number, body: unknown) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const metodo = init.method ?? 'GET';
    llamadas.push({ metodo, url: url.toString(), headers: Object.fromEntries(new Headers(init.headers).entries()), cuerpo: String(init.body ?? '') });
    if (url.host === 'accounts.zoho.eu') return o.tokenStatus ? json(o.tokenStatus, { error: 'invalid_code' }) : json(200, { access_token: 'at', expires_in: 3600 });
    if (url.host === 'calendar.zoho.eu') {
      const uid = url.pathname.split('/')[6]; // /api/v1/calendars/{cal}/events/{uid}
      if (metodo === 'POST') {
        const data = JSON.parse(url.searchParams.get('eventdata')!);
        const ev = o.zohoEvento ?? { uid: 'ev-1', etag: 1700000000000, title: data.title, description: data.description, isallday: false, dateandtime: data.dateandtime };
        eventos.set(String(ev.uid), ev);
        return json(201, { events: [ev] });
      }
      if (metodo === 'GET') return eventos.has(uid!) ? json(200, { events: [eventos.get(uid!)] }) : json(404, { error: [{ code: 'NOT_FOUND' }] });
      if (metodo === 'DELETE') { eventos.delete(uid!); return json(200, { events: [] }); }
    }
    if (url.host === 'evo.staging.example') {
      if (url.pathname.startsWith('/chat/whatsappNumbers/')) return json(200, [{ exists: o.existe ?? true, number: '528112345678' }]);
      if (url.pathname.startsWith('/message/sendText/')) return json(201, { key: { id: 'MSG1' }, status: 'PENDING' });
    }
    if (url.pathname.endsWith('/citas-api')) return json(200, o.slots ?? SLOTS_OK);
    if (url.pathname.endsWith('/tracking-ingest')) return json(o.ingestStatus ?? 405, { error: 'METODO' });
    return json(599, {});
  }) as typeof fetch;
  return { f, llamadas, eventos };
}

const correr = (o: Parameters<typeof fetchFalso>[0] = {}, env: Record<string, string> = ENV) => {
  const ff = fetchFalso(o);
  const cfg = leerConfig(env).cfg as ConfigSmoke;
  return ejecutarSmoke({ cfg, fetch: ff.f, dominio, ahora: () => new Date('2026-11-17T08:00:00Z'), codigo: () => '123456' }).then((r) => ({ ...r, ff }));
};

describe('configuración', () => {
  it('lista los secretos/variables que faltan (el workflow se marca omitido, sin verde falso)', () => {
    expect(leerConfig({}).faltan).toEqual(expect.arrayContaining(['ZOHO_CLIENT_ID', 'ZOHO_REFRESH_TOKEN', 'ZOHO_CALENDARIO_PRUEBA', 'EVOLUTION_API_KEY', 'SMOKE_TELEFONO_PRUEBA', 'STAGING_FUNCIONES_URL']));
    expect(leerConfig(ENV).faltan).toEqual([]);
  });
  it('DC configurable (por defecto com) y teléfono normalizado a 52 + 10 dígitos', () => {
    const { cfg } = leerConfig({ ...ENV, ZOHO_DC: '', SMOKE_TELEFONO_PRUEBA: '+52 81 1234 5678' });
    expect(cfg.zoho.dc).toBe('com');
    expect(cfg.telefono).toBe('528112345678');
  });
});

describe('smoke contra staging (fetch falso)', () => {
  it('todo verde: crea y borra el evento en Zoho (contrato Zod), OTP por Evolution, citas-api y tracking-ingest', async () => {
    const r = await correr();
    expect(r.checks.map((c) => [c.nombre, c.ok])).toEqual([
      ['zoho.crear', true], ['zoho.obtener', true], ['zoho.borrar', true],
      ['evolution.existe', true], ['evolution.otp', true],
      ['citas-api', true], ['tracking-ingest', true],
    ]);
    expect(r.ok).toBe(true);
    expect(r.ff.eventos.size).toBe(0); // el evento de prueba no queda en el calendario
    const crear = r.ff.llamadas.find((l) => l.metodo === 'POST' && l.url.includes('calendar.zoho.eu'))!;
    const data = JSON.parse(new URL(crear.url).searchParams.get('eventdata')!);
    expect(data).toMatchObject({ isallday: false });
    expect(data).not.toHaveProperty('reminders'); // Zoho rechaza [] (ARRAY_SIZE_OUT_OF_RANGE 1-4)
    expect(data).not.toHaveProperty('attendees');
    const otp = r.ff.llamadas.find((l) => l.url.includes('/message/sendText/'))!;
    expect(JSON.parse(otp.cuerpo)).toEqual({ number: '528112345678', text: expect.stringContaining('123456') });
    const slots = r.ff.llamadas.find((l) => l.url.includes('/citas-api'))!;
    expect(slots.url).toBe('https://stg.supabase.co/functions/v1/citas-api?vacante=agente-smart');
    expect(slots.headers.origin).toBe('https://staging.369capitalhumano.com');
  });

  it('Zoho fuera de contrato (evento sin uid/dateandtime) → zoho.crear falla con el motivo del esquema', async () => {
    const r = await correr({ zohoEvento: { title: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.nombre === 'zoho.crear')).toMatchObject({ ok: false, detalle: expect.stringMatching(/fuera de contrato/) });
  });

  it('refresh token rechazado → falla Zoho, el resto se sigue verificando', async () => {
    const r = await correr({ tokenStatus: 400 });
    expect(r.checks.find((c) => c.nombre === 'zoho.crear')).toMatchObject({ ok: false, detalle: expect.stringMatching(/refresh token/) });
    expect(r.checks.find((c) => c.nombre === 'citas-api')!.ok).toBe(true);
  });

  it('número de prueba sin WhatsApp → no envía el OTP', async () => {
    const r = await correr({ existe: false });
    expect(r.checks.find((c) => c.nombre === 'evolution.existe')!.ok).toBe(false);
    expect(r.checks.find((c) => c.nombre === 'evolution.otp')).toMatchObject({ ok: false, detalle: expect.stringMatching(/omitido/) });
    expect(r.ff.llamadas.some((l) => l.url.includes('/message/sendText/'))).toBe(false);
  });

  it('citas-api con forma inválida o tracking-ingest caído (5xx) → falla', async () => {
    const r = await correr({ slots: { slots: 'x' }, ingestStatus: 503 });
    expect(r.checks.find((c) => c.nombre === 'citas-api')).toMatchObject({ ok: false, detalle: expect.stringMatching(/forma/) });
    expect(r.checks.find((c) => c.nombre === 'tracking-ingest')).toMatchObject({ ok: false, detalle: expect.stringMatching(/503/) });
    expect(r.ok).toBe(false);
  });

  it('el resumen no expone secretos ni el teléfono de prueba', async () => {
    const r = await correr();
    const md = resumenMarkdown(r);
    expect(md).toMatch(/zoho\.crear/);
    expect(md).not.toMatch(/8112345678|rtok|csec/);
  });
});
