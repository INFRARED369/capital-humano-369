import { describe, expect, it } from 'vitest';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerAlertas } from './handler.ts';

const SECRETO = 'service-role-key-de-prueba-123';
const post = (auth?: string, metodo = 'POST') => new Request('https://fn/alertas', { method: metodo, headers: auth ? { authorization: auth } : {} });

describe('handler de la edge function alertas', () => {
  it('Bearer correcto → 200 con el resumen', async () => {
    const h = crearHandlerAlertas({ secreto: SECRETO, correr: async () => ({ nuevas: 1 }), log: crearLogger({}, () => {}) });
    const r = await h(post(`Bearer ${SECRETO}`));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, nuevas: 1 });
  });
  it('sin Bearer o incorrecto → 401; método distinto de POST → 405', async () => {
    const h = crearHandlerAlertas({ secreto: SECRETO, correr: async () => ({}), log: crearLogger({}, () => {}) });
    expect((await h(post())).status).toBe(401);
    expect((await h(post('Bearer otro'))).status).toBe(401);
    expect((await h(post(`Bearer ${SECRETO}`, 'GET'))).status).toBe(405);
  });
  it('excepción → 500 genérico sin detalles; secreto corto → error al crear', async () => {
    const logs: string[] = [];
    const h = crearHandlerAlertas({ secreto: SECRETO, correr: async () => { throw new Error('conexión rechazada'); }, log: crearLogger({}, (l) => logs.push(l)) });
    const r = await h(post(`Bearer ${SECRETO}`));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'INTERNO' });
    expect(() => crearHandlerAlertas({ secreto: 'corto', correr: async () => ({}), log: crearLogger({}, () => {}) })).toThrow();
  });
});
