/** Handlers HTTP puros (Request → Response) de postular, verificar-otp y contacto-b2b. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@shared/ids.ts';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearVacante } from '../../../../../test/db/fixtures.ts';
import { crearDepsPrueba } from '../testing/fakes.ts';
import { crearHandlerContactoB2B, crearHandlerPostular, crearHandlerVerificarOtp } from './handlers.ts';

const ORIGEN = 'https://369capitalhumano.com';
let db: TestDb;
let t: ReturnType<typeof crearDepsPrueba>;
beforeEach(async () => {
  db = await crearTestDb();
  await crearVacante(db.sql, { slug: 'agente-smart' });
  t = crearDepsPrueba(db.servicio);
}, 120_000);
afterEach(async () => { await db.close(); });

const req = (url: string, body: unknown, init: { metodo?: string; headers?: Record<string, string>; crudo?: string } = {}) =>
  new Request(url, {
    method: init.metodo ?? 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGEN, 'cf-connecting-ip': '189.203.1.2', 'x-correlation-id': 'corr-12345678', ...init.headers },
    body: (init.metodo ?? 'POST') === 'POST' ? (init.crudo ?? JSON.stringify(body)) : undefined,
  });

const cuerpo = (c: Record<string, unknown> = {}) => ({
  vacante: 'agente-smart', nombre: 'Rosa Díaz', telefono: '8112345678', respuestas: { edad: 25, manejo_pc: 'no', papeleria: 'no' },
  slot_inicio: '2026-11-17T16:00:00.000Z', consentimiento: { aceptado: true, version: '2026-11-13' }, turnstile_token: 'ok', event_id: uuidv7(), ...c,
});

describe('postular (HTTP)', () => {
  const h = () => crearHandlerPostular(t.deps, { origenPermitido: ORIGEN });
  it('201 con folio, cita y OTP; CORS y sin datos personales en la respuesta', async () => {
    const r = await h()(req('https://x/functions/v1/postular', cuerpo()));
    expect(r.status).toBe(201);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    const b = await r.json();
    expect(b).toMatchObject({ lead_id: expect.any(String), folio: expect.stringMatching(/^369-/), reutilizado: false, cita: { inicio: '2026-11-17T16:00:00.000Z' }, otp: { expira_en: '2026-11-16T15:10:00.000Z', reenvios_restantes: 2 } });
    expect(JSON.stringify(b)).not.toMatch(/8112345678|Rosa/);
  });
  it.each([
    ['422 formato', cuerpo({ telefono: '123' }), 422, 'FORMATO_INVALIDO'],
    ['422 consentimiento', cuerpo({ consentimiento: { aceptado: false, version: 'v' } }), 422, 'CONSENTIMIENTO_REQUERIDO'],
    ['403 sin anti-bot', cuerpo({ turnstile_token: '' }), 403, 'ANTIBOT_REQUERIDO'],
    ['403 anti-bot inválido', cuerpo({ turnstile_token: 'x' }), 403, 'ANTIBOT_INVALIDO'],
    ['404 vacante', cuerpo({ vacante: 'nada' }), 404, 'VACANTE_NO_ENCONTRADA'],
    ['503 anti-bot caído (fallback)', cuerpo({ turnstile_token: 'caido' }), 503, 'ANTIBOT_NO_DISPONIBLE'],
  ])('%s', async (_n, body, status, codigo) => {
    const r = await h()(req('https://x/postular', body));
    expect(r.status).toBe(status);
    const b = await r.json();
    expect(b.error).toBe(codigo);
    if (status >= 500) expect(b.fallback_whatsapp).toBe(true);
  });
  it('422 WHATSAPP_INVALIDO (P7) y 409 elige otro horario', async () => {
    t.whatsapp.inexistentes.add('528112345678');
    expect((await h()(req('https://x/postular', cuerpo()))).status).toBe(422);
    t.whatsapp.inexistentes.clear();
    t.agenda.errorRetener = 'SLOT_LLENO';
    const r = await h()(req('https://x/postular', cuerpo()));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'SLOT_LLENO', elegir_otro_horario: true });
  });
  it('429 con Retry-After al exceder el límite', async () => {
    for (let i = 0; i < 3; i++) await h()(req('https://x/postular', cuerpo()));
    const r = await h()(req('https://x/postular', cuerpo()));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('3600');
  });
  it('preflight, método, origen, tipo de contenido, tamaño y JSON inválido', async () => {
    expect((await h()(req('https://x/postular', null, { metodo: 'OPTIONS' }))).status).toBe(204);
    expect((await h()(req('https://x/postular', null, { metodo: 'GET' }))).status).toBe(405);
    expect((await h()(req('https://x/postular', cuerpo(), { headers: { origin: 'https://malo.com' } }))).status).toBe(403);
    expect((await h()(req('https://x/postular', cuerpo(), { headers: { 'content-type': 'text/plain' } }))).status).toBe(415);
    expect((await h()(req('https://x/postular', null, { crudo: JSON.stringify({ x: 'a'.repeat(20_000) }) }))).status).toBe(413);
    expect((await h()(req('https://x/postular', null, { crudo: '{malo' }))).status).toBe(400);
  });
  it('500 genérico con fallback y sin filtrar detalles si algo inesperado falla', async () => {
    t.mensajeria.fallar = true;
    const r = await h()(req('https://x/postular', cuerpo()));
    expect(r.status).toBe(500);
    const b = await r.json();
    expect(b).toEqual({ error: 'ERROR_INTERNO', fallback_whatsapp: true });
    expect(t.logs.join('\n')).toContain('corr-12345678');
  });
});

describe('verificar-otp (HTTP)', () => {
  it('verifica, reenvía (ruta /reenviar) y mapea estados', async () => {
    const p = await (await crearHandlerPostular(t.deps, { origenPermitido: ORIGEN })(req('https://x/postular', cuerpo()))).json();
    const h = crearHandlerVerificarOtp(t.deps, { origenPermitido: ORIGEN });
    const malo = t.cifrador.codigos[0] === '000000' ? '111111' : '000000';
    const r1 = await h(req('https://x/functions/v1/verificar-otp', { lead_id: p.lead_id, codigo: malo }));
    expect(r1.status).toBe(422);
    expect(await r1.json()).toEqual({ error: 'OTP_INCORRECTO', intentos_restantes: 4 });

    t.agenda.expiraExtendida = '2026-11-16T15:10:00.000Z';
    const re = await h(req('https://x/functions/v1/verificar-otp/reenviar', { lead_id: p.lead_id }));
    expect(re.status).toBe(200);
    expect(await re.json()).toEqual({ expira_en: '2026-11-16T15:10:00.000Z', reenvios_restantes: 1, canal: 'whatsapp', retencion_expira_en: '2026-11-16T15:10:00.000Z' });

    const ok = await h(req('https://x/functions/v1/verificar-otp', { lead_id: p.lead_id, codigo: t.cifrador.codigos[1] }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ folio: p.folio, nombre_pila: 'Rosa', cita: { inicio: '2026-11-17T16:00:00.000Z', fin: '2026-11-17T17:30:00.000Z' } });

    const otra = await h(req('https://x/functions/v1/verificar-otp', { lead_id: p.lead_id, codigo: t.cifrador.codigos[1] }));
    expect(otra.status).toBe(409);
    expect(await otra.json()).toEqual({ error: 'YA_VERIFICADO', folio: p.folio });
  });
  it('410 vencido con puede_reenviar, 423 bloqueado y 404 desconocido', async () => {
    const p = await (await crearHandlerPostular(t.deps, { origenPermitido: ORIGEN })(req('https://x/postular', cuerpo()))).json();
    const h = crearHandlerVerificarOtp(t.deps, { origenPermitido: ORIGEN });
    t.clock.advanceMinutes(11);
    const v = await h(req('https://x/verificar-otp', { lead_id: p.lead_id, codigo: t.cifrador.codigos[0] }));
    expect(v.status).toBe(410);
    expect(await v.json()).toEqual({ error: 'OTP_VENCIDO', puede_reenviar: true });
    await h(req('https://x/verificar-otp/reenviar', { lead_id: p.lead_id }));
    const malo = t.cifrador.codigos[1] === '000000' ? '111111' : '000000';
    let ultimo: Response | null = null;
    for (let i = 0; i < 5; i++) ultimo = await h(req('https://x/verificar-otp', { lead_id: p.lead_id, codigo: malo }));
    expect(ultimo!.status).toBe(423);
    expect((await h(req('https://x/verificar-otp', { lead_id: globalThis.crypto.randomUUID(), codigo: '123456' }))).status).toBe(404);
  });
});

describe('contacto-b2b (HTTP)', () => {
  it('201 y validaciones', async () => {
    const h = crearHandlerContactoB2B(t.deps, { origenPermitido: ORIGEN });
    const base = { nombre: 'Laura', empresa: 'ACME', email: 'l@acme.mx', servicio: 'Solución integral', consentimiento: { aceptado: true, version: 'v' }, turnstile_token: 'ok' };
    expect((await h(req('https://x/contacto-b2b', base))).status).toBe(201);
    expect((await h(req('https://x/contacto-b2b', { ...base, email: 'x' }))).status).toBe(422);
    expect((await h(req('https://x/contacto-b2b', { ...base, turnstile_token: 'no' }))).status).toBe(403);
  });
});
