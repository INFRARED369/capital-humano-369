import { describe, expect, it } from 'vitest';
import { URL_SITEVERIFY, crearTurnstileAdapter } from './turnstile.ts';

describe('adaptador Turnstile (verificación server-side, NFR-SEG-03)', () => {
  it('envía secreto, token e IP y devuelve success', async () => {
    const llamadas: Array<{ url: string; body: string }> = [];
    const fetchFalso = async (url: string | URL | Request, init?: RequestInit) => {
      llamadas.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    const a = crearTurnstileAdapter({ secret: 's3cr3t' }, fetchFalso as typeof fetch);
    expect(await a.verificar('tok', '1.2.3.4')).toBe(true);
    expect(llamadas[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const p = new URLSearchParams(llamadas[0]!.body);
    expect(Object.fromEntries(p)).toEqual({ secret: 's3cr3t', response: 'tok', remoteip: '1.2.3.4' });
  });
  it('success false → false; sin IP no la envía', async () => {
    let body = '';
    const a = crearTurnstileAdapter({ secret: 's' }, (async (_u: unknown, i?: RequestInit) => { body = String(i?.body); return new Response('{"success":false}'); }) as typeof fetch);
    expect(await a.verificar('tok', null)).toBe(false);
    expect(body).not.toContain('remoteip');
  });
  it('error HTTP del proveedor → lanza (el caso de uso responde 503 + fallback)', async () => {
    const a = crearTurnstileAdapter({ secret: 's' }, (async () => new Response('x', { status: 500 })) as typeof fetch);
    await expect(a.verificar('tok', null)).rejects.toThrow();
  });
  it('exige secreto', () => {
    expect(() => crearTurnstileAdapter({ secret: '' })).toThrow();
  });
});

describe('TURNSTILE_URL configurable (solo pruebas locales)', () => {
  const okFetch = (async (u: string) => { llamadas.push(u); return new Response(JSON.stringify({ success: true })); }) as unknown as typeof fetch;
  const llamadas: string[] = [];
  it('usa la URL indicada si es local', async () => {
    const a = crearTurnstileAdapter({ secret: 's', url: 'http://host.docker.internal:9999/siteverify' }, okFetch);
    expect(await a.verificar('t', null)).toBe(true);
    expect(llamadas.at(-1)).toBe('http://host.docker.internal:9999/siteverify');
  });
  it('rechaza http no local', () => {
    expect(() => crearTurnstileAdapter({ secret: 's', url: 'http://evil.example.com/siteverify' }, okFetch)).toThrow(/https/);
  });
  it('por defecto usa Cloudflare', async () => {
    await crearTurnstileAdapter({ secret: 's' }, okFetch).verificar('t', null);
    expect(llamadas.at(-1)).toBe(URL_SITEVERIFY);
  });
});
