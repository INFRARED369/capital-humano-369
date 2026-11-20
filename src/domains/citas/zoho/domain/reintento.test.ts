import { describe, expect, it } from 'vitest';
import { MAX_INTENTOS, backoffSegundos, esReintentable } from './reintento.ts';

describe('política de reintento (CIT-08, NFR-DISP-01)', () => {
  it('1 intento + 2 reintentos (coincide con max_intentos=3 de la cola base)', () => {
    expect(MAX_INTENTOS).toBe(3);
  });

  it('backoff exponencial acotado: 30 s, 120 s', () => {
    expect(backoffSegundos(1)).toBe(30);
    expect(backoffSegundos(2)).toBe(120);
    expect(backoffSegundos(9)).toBe(900);
    expect(backoffSegundos(0)).toBe(30);
  });

  it('reintenta transitorios y conflictos de etag; no los permanentes ni auth', () => {
    expect(esReintentable({ tipo: 'transitorio', mensaje: '500' })).toBe(true);
    expect(esReintentable({ tipo: 'conflicto', mensaje: 'etag' })).toBe(true);
    expect(esReintentable({ tipo: 'permanente', mensaje: '400' })).toBe(false);
    expect(esReintentable({ tipo: 'auth', mensaje: '401' })).toBe(false);
    expect(esReintentable({ tipo: 'no_encontrado', mensaje: '404' })).toBe(false);
  });
});
