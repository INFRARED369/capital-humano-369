import { describe, expect, it } from 'vitest';
import { configurarZodSinEval } from './zod-sin-eval';

describe('Zod sin eval (CSP estricta)', () => {
  it('activa jitless conservando la configuración previa', () => {
    const previa = { locale: 'es' };
    const g: { __zod_globalConfig?: Record<string, unknown> } = { __zod_globalConfig: previa };
    configurarZodSinEval(g);
    expect(g.__zod_globalConfig).toBe(previa); // misma referencia que ya tomó Zod
    expect(previa).toEqual({ locale: 'es', jitless: true });
    const vacio: { __zod_globalConfig?: Record<string, unknown> } = {};
    configurarZodSinEval(vacio);
    expect(vacio.__zod_globalConfig).toEqual({ jitless: true });
  });
});
