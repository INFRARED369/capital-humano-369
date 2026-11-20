import { describe, expect, it } from 'vitest';
import sendText from './__fixtures__/evolution-sendText-201.json';
import numeros from './__fixtures__/evolution-whatsappNumbers-200.json';
import err400 from './__fixtures__/evolution-error-400.json';
import err401 from './__fixtures__/evolution-error-401.json';
import nbxSend from './__fixtures__/nbx-send-200.json';
import { crearEvolutionAdapter, EvolutionSendTextSchema, EvolutionWhatsappNumbersSchema } from './evolution.ts';
import { aGsm, crearNbxSmsAdapter, largoGsm, telefonoNbx } from './nbx.ts';
import { crearEmailSmtpAdapter } from './email.ts';

type Llamada = { url: string; init: RequestInit };
function fetchFalso(respuestas: Array<Response | Error>) {
  const llamadas: Llamada[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    const r = respuestas.shift();
    if (!r) throw new Error('sin respuesta');
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { impl, llamadas };
}
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CFG = { url: 'https://evo.example.com/', apiKey: 'k-123', instancia: '369 inst' };

describe('contrato Evolution API v2 (fixtures)', () => {
  it('los fixtures cumplen los esquemas Zod', () => {
    expect(EvolutionSendTextSchema.safeParse(sendText).success).toBe(true);
    expect(EvolutionWhatsappNumbersSchema.safeParse(numeros).success).toBe(true);
  });

  it('enviarTexto: POST /message/sendText/{instance} con apikey y devuelve el id del proveedor', async () => {
    const f = fetchFalso([resp(sendText, 201)]);
    const r = await crearEvolutionAdapter(CFG, f.impl).enviarTexto('528112345678', 'hola');
    expect(r).toEqual({ ok: true, value: { proveedorId: 'BAE594145F4C59B4' } });
    expect(f.llamadas[0]!.url).toBe('https://evo.example.com/message/sendText/369%20inst');
    expect(f.llamadas[0]!.init.method).toBe('POST');
    expect((f.llamadas[0]!.init.headers as Record<string, string>).apikey).toBe('k-123');
    expect(JSON.parse(f.llamadas[0]!.init.body as string)).toEqual({ number: '528112345678', text: 'hola' });
  });

  it('400 → error permanente; 401 → permanente (configuración); 5xx/429/red → transitorio', async () => {
    const f = fetchFalso([resp(err400, 400), resp(err401, 401), resp({}, 503), resp({}, 429), new Error('ECONNRESET')]);
    const a = crearEvolutionAdapter(CFG, f.impl);
    const e400 = await a.enviarTexto('525500000000', 'x');
    // El motivo explica el 400 (número sin WhatsApp) sin guardar el teléfono ni el JID.
    expect(e400).toMatchObject({ ok: false, error: { permanente: true, motivo: expect.stringMatching(/^HTTP_400: .*exists :false/) } });
    expect(JSON.stringify(e400)).not.toMatch(/5500000000|whatsapp\.net/);
    expect(await a.enviarTexto('5', 'x')).toMatchObject({ ok: false, error: { motivo: expect.stringMatching(/^HTTP_401/), permanente: true } });
    expect(await a.enviarTexto('5', 'x')).toEqual({ ok: false, error: { motivo: 'HTTP_503', permanente: false } });
    expect(await a.enviarTexto('5', 'x')).toEqual({ ok: false, error: { motivo: 'HTTP_429', permanente: false } });
    expect(await a.enviarTexto('5', 'x')).toEqual({ ok: false, error: { motivo: 'RED', permanente: false } });
  });

  it('respuesta 2xx que no cumple el contrato → transitorio CONTRATO_INVALIDO', async () => {
    const f = fetchFalso([resp({ foo: 1 }, 201)]);
    expect(await crearEvolutionAdapter(CFG, f.impl).enviarTexto('5', 'x')).toEqual({ ok: false, error: { motivo: 'CONTRATO_INVALIDO', permanente: false } });
  });

  it('COM-08 existeEnWhatsApp: POST /chat/whatsappNumbers/{instance}', async () => {
    const f = fetchFalso([resp(numeros), resp([numeros[1]]), resp([])]);
    const a = crearEvolutionAdapter(CFG, f.impl);
    expect(await a.existeEnWhatsApp('528112345678')).toBe(true);
    expect(f.llamadas[0]!.url).toBe('https://evo.example.com/chat/whatsappNumbers/369%20inst');
    expect(JSON.parse(f.llamadas[0]!.init.body as string)).toEqual({ numbers: ['528112345678'] });
    expect(await a.existeEnWhatsApp('525500000000')).toBe(false);
    expect(await a.existeEnWhatsApp('525500000001')).toBe(false);
  });

  it('existeEnWhatsApp lanza ante error del proveedor (captación decide), sin PII en el mensaje', async () => {
    const f = fetchFalso([resp(err401, 401), new Error('boom 528112345678')]);
    const a = crearEvolutionAdapter(CFG, f.impl);
    await expect(a.existeEnWhatsApp('528112345678')).rejects.toThrow('EVOLUTION_HTTP_401');
    await expect(a.existeEnWhatsApp('528112345678')).rejects.toThrow(/^EVOLUTION_RED$/);
  });

  it('valida la configuración', () => {
    expect(() => crearEvolutionAdapter({ ...CFG, url: 'http://inseguro' }, fetch)).toThrow(/https/);
    expect(() => crearEvolutionAdapter({ ...CFG, apiKey: '' }, fetch)).toThrow();
  });
});

describe('SMS NBX (POST /v2/sms/send, Basic, phone 10 dígitos, msg GSM ≤ 160)', () => {
  const cfg = { url: 'https://api.nbx.example', apiKey: 'nbx-k', remitente: '369' };
  it('envía phone a 10 dígitos, msg y sender con Basic; toma id y costo de la respuesta', async () => {
    const f = fetchFalso([resp(nbxSend)]);
    const a = crearNbxSmsAdapter(cfg, f.impl);
    expect(a.proveedor).toBe('nbx');
    expect(await a.enviarSms('528112345678', 'hola')).toEqual({ ok: true, value: { proveedorId: 'nbx-7f3a9c', costoMxn: 0.29 } });
    expect(f.llamadas[0]!.url).toBe('https://api.nbx.example/v2/sms/send');
    expect(JSON.parse(f.llamadas[0]!.init.body as string)).toEqual({ phone: '8112345678', msg: 'hola', sender: '369' });
    expect((f.llamadas[0]!.init.headers as Record<string, string>).authorization).toBe('Basic nbx-k');
  });
  it('acepta la URL completa y un token que ya trae "Basic"; sin sender usa el default de NBX', async () => {
    const f = fetchFalso([resp({ message_id: 77 })]);
    const a = crearNbxSmsAdapter({ url: 'https://api.nbx.example/v2/sms/send/', apiKey: 'Basic abc123', remitente: undefined }, f.impl);
    expect(await a.enviarSms('528112345678', 't')).toEqual({ ok: true, value: { proveedorId: '77' } });
    expect(f.llamadas[0]!.url).toBe('https://api.nbx.example/v2/sms/send');
    expect(JSON.parse(f.llamadas[0]!.init.body as string)).toEqual({ phone: '8112345678', msg: 't' });
    expect((f.llamadas[0]!.init.headers as Record<string, string>).authorization).toBe('Basic abc123');
  });
  it('errores clasificados: HTTP, teléfono inválido y mensaje de más de 160 (sin recortar ni llamar)', async () => {
    const f = fetchFalso([resp({}, 422), resp({}, 500)]);
    const a = crearNbxSmsAdapter(cfg, f.impl);
    expect(await a.enviarSms('528112345678', 't')).toEqual({ ok: false, error: { motivo: 'HTTP_422', permanente: true } });

    expect(await a.enviarSms('528112345678', 't')).toEqual({ ok: false, error: { motivo: 'HTTP_500', permanente: false } });
    expect(await a.enviarSms('5212', 't')).toEqual({ ok: false, error: { motivo: 'TELEFONO_INVALIDO', permanente: true } });
    expect(await a.enviarSms('528112345678', 'x'.repeat(161))).toEqual({ ok: false, error: { motivo: 'SMS_EXCEDE_160', permanente: true } });
    expect(f.llamadas).toHaveLength(2);
  });
  it('un 403 de NBX guarda el porqué sin datos personales ni tokens', async () => {
    const f = fetchFalso([new Response('{"error":"Forbidden","message":"IP 34.1.2.3 no autorizada para 8112345678, token AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}', { status: 403 })]);
    const r = await crearNbxSmsAdapter(cfg, f.impl).enviarSms('528112345678', 't');
    expect(r).toMatchObject({ ok: false, error: { permanente: true, motivo: expect.stringMatching(/^HTTP_403: error : Forbidden , message : IP .* no autorizada/) } });
    expect(JSON.stringify(r)).not.toMatch(/8112345678|AbCdEfGhIjKl/);
  });
  it('el OTP por defecto cabe en un SMS y sale en GSM 03.38 (sin á/í/ó/ú)', async () => {
    const f = fetchFalso([resp({})]);
    await crearNbxSmsAdapter(cfg, f.impl).enviarSms('528112345678', 'Tu código de verificación de 369 Capital Humano es 123456. Vence en 10 minutos. No lo compartas.');
    const { msg } = JSON.parse(f.llamadas[0]!.init.body as string) as { msg: string };
    expect(msg).toBe('Tu codigo de verificacion de 369 Capital Humano es 123456. Vence en 10 minutos. No lo compartas.');
    expect(largoGsm(msg)).toBeLessThanOrEqual(160);
  });
  it('aGsm conserva é/ñ/ü/¿/¡, quita acentos sin GSM, sustituye tipografía y descarta emojis; telefonoNbx', () => {
    expect(aGsm('¿Cómo estás, Íñigo? ¡Qué día! Güero · “folio” – ok 😀')).toBe('¿Como estas, Iñigo? ¡Qué dia! Güero - "folio" - ok ');
    expect(largoGsm('a€[')).toBe(5);
    expect(telefonoNbx('528112345678')).toBe('8112345678');
    expect(telefonoNbx('8112345678')).toBe('8112345678');
    expect(telefonoNbx('12345')).toBeNull();
  });
});

describe('Email (SMTP detrás de EmailPort)', () => {
  it('envía con el transporte inyectado (nodemailer en Deno) y devuelve messageId', async () => {
    const enviados: unknown[] = [];
    const a = crearEmailSmtpAdapter({ remitente: '369 <no-responder@369.mx>' }, { sendMail: async (o) => (enviados.push(o), { messageId: '<abc@369>' }) });
    expect(await a.enviar({ para: 'ana@example.com', asunto: 'A', texto: 'T' })).toEqual({ ok: true, value: { proveedorId: '<abc@369>' } });
    expect(enviados).toEqual([{ from: '369 <no-responder@369.mx>', to: 'ana@example.com', subject: 'A', text: 'T' }]);
  });
  it('códigos SMTP 5xx → permanente; 4xx/red → transitorio', async () => {
    const lanzar = (e: unknown) => crearEmailSmtpAdapter({ remitente: 'x@y.z' }, { sendMail: async () => { throw e; } });
    expect(await lanzar(Object.assign(new Error('x'), { responseCode: 550 })).enviar({ para: 'a@b.c', asunto: 'a', texto: 't' })).toEqual({ ok: false, error: { motivo: 'SMTP_550', permanente: true } });
    expect(await lanzar(Object.assign(new Error('x'), { responseCode: 421 })).enviar({ para: 'a@b.c', asunto: 'a', texto: 't' })).toEqual({ ok: false, error: { motivo: 'SMTP_421', permanente: false } });
    const relay = Object.assign(new Error('x'), { responseCode: 550, response: '550 5.7.1 Sender <no-responder@369.mx> is not allowed to relay emails from a@b.c' });
    expect(await lanzar(relay).enviar({ para: 'a@b.c', asunto: 'a', texto: 't' })).toEqual({ ok: false, error: { motivo: 'SMTP_550: 5.7.1 Sender is not allowed to relay emails from', permanente: true } });
    expect(await lanzar(new Error('ETIMEDOUT')).enviar({ para: 'a@b.c', asunto: 'a', texto: 't' })).toEqual({ ok: false, error: { motivo: 'SMTP_RED', permanente: false } });
  });
  it('rechaza saltos de línea en el asunto (inyección de cabeceras)', async () => {
    const a = crearEmailSmtpAdapter({ remitente: 'x@y.z' }, { sendMail: async () => ({ messageId: '1' }) });
    expect(await a.enviar({ para: 'a@b.c', asunto: 'hola\r\nBcc: x@evil', texto: 't' })).toEqual({ ok: false, error: { motivo: 'CABECERA_INVALIDA', permanente: true } });
  });
});
