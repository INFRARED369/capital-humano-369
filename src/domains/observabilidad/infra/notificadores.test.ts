import { describe, expect, it } from 'vitest';
import type { EmailPort } from '@domains/comunicacion/index.ts';
import type { Alerta } from '../domain/alertas.ts';
import { crearNotificadorEmail, crearNotificadorWebhook } from './notificadores.ts';

const alertas: Alerta[] = [{ id: '1', tipo: 'otp_tasa_fallas', severidad: 'critica', clave: 'otp:1', creadaEn: '2026-11-17T18:00:00Z', detalle: { tasa: 0.2, emitidos: 10 } }];

function fetchFalso(respuestas: (number | Error)[]) {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    const r = respuestas.shift() ?? 200;
    if (r instanceof Error) throw r;
    return new Response(r === 204 ? null : 'ok', { status: r });
  }) as unknown as typeof fetch;
  return { f, llamadas };
}

describe('webhook genérico (Slack/Discord)', () => {
  it('POST JSON con timeout; 2xx → ok', async () => {
    const { f, llamadas } = fetchFalso([204]);
    const n = crearNotificadorWebhook({ url: 'https://hooks.slack.com/services/T/B/X', fetch: f });
    expect(n.canal).toBe('webhook');
    expect(await n.notificar(alertas)).toEqual({ ok: true, value: undefined });
    expect(llamadas[0]!.url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(llamadas[0]!.init.method).toBe('POST');
    expect((llamadas[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(llamadas[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(llamadas[0]!.init.body))).toMatchObject({ text: expect.stringContaining('otp_tasa_fallas'), alertas: [{ tipo: 'otp_tasa_fallas' }] });
  });
  it('no 2xx → HTTP_<status>; red → RED', async () => {
    const { f } = fetchFalso([500, new TypeError('dns')]);
    const n = crearNotificadorWebhook({ url: 'https://discord.com/api/webhooks/1/x', fetch: f });
    expect(await n.notificar(alertas)).toEqual({ ok: false, error: 'HTTP_500' });
    expect(await n.notificar(alertas)).toEqual({ ok: false, error: 'RED' });
  });
  it('exige https', () => {
    expect(() => crearNotificadorWebhook({ url: 'http://hooks.example.com/x', fetch: fetchFalso([]).f })).toThrow(/https/);
  });
});

describe('correo vía EmailPort de comunicación', () => {
  it('un correo por destinatario con asunto y texto formateados; falla si alguno falla', async () => {
    const enviados: { para: string; asunto: string; texto: string }[] = [];
    let fallar = false;
    const email: EmailPort = {
      proveedor: 'smtp',
      enviar: async (m) => { enviados.push(m); return fallar ? { ok: false, error: { motivo: 'SMTP_550', permanente: true } } : { ok: true, value: { proveedorId: null } }; },
    };
    const n = crearNotificadorEmail({ email, para: ['ops@369.mx', 'guardia@369.mx'], entorno: 'produccion' });
    expect(n.canal).toBe('email');
    expect(await n.notificar(alertas)).toEqual({ ok: true, value: undefined });
    expect(enviados.map((e) => e.para)).toEqual(['ops@369.mx', 'guardia@369.mx']);
    expect(enviados[0]!.asunto).toBe('[369 · produccion] 1 alerta(s), 1 crítica(s)');
    expect(enviados[0]!.texto).toContain('[CRITICA] otp_tasa_fallas');
    fallar = true;
    expect(await n.notificar(alertas)).toEqual({ ok: false, error: 'SMTP_550' });
  });
  it('lista de correos desde texto separado por comas; vacía o inválida → error al crear', () => {
    const email: EmailPort = { proveedor: 'smtp', enviar: async () => ({ ok: true, value: { proveedorId: null } }) };
    expect(() => crearNotificadorEmail({ email, para: [] })).toThrow(/ALERTAS_EMAIL/);
    expect(() => crearNotificadorEmail({ email, para: ['no-es-correo'] })).toThrow(/ALERTAS_EMAIL/);
  });
});
