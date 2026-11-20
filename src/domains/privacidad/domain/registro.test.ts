/** PRV-03: el registro de supresiones guarda solo conteos, fechas y reglas; nunca datos borrados. */
import { describe, expect, it } from 'vitest';
import { DOMINIOS_RETENCION, esSoloConteos, faltantes, sumarConteos, totalConteos, validarRegistro } from './registro.ts';

describe('esSoloConteos', () => {
  it('acepta números enteros no negativos, anidados', () => {
    expect(esSoloConteos({ a: 1, b: { c: 0, d: { e: 3 } } })).toBe(true);
    expect(esSoloConteos({})).toBe(true);
  });
  it('rechaza cualquier texto, arreglo, booleano, nulo o número negativo/decimal', () => {
    expect(esSoloConteos({ telefono: '5281…' })).toBe(false);
    expect(esSoloConteos({ ids: ['0190…'] })).toBe(false);
    expect(esSoloConteos({ a: true })).toBe(false);
    expect(esSoloConteos({ a: null })).toBe(false);
    expect(esSoloConteos({ a: -1 })).toBe(false);
    expect(esSoloConteos({ a: 1.5 })).toBe(false);
    expect(esSoloConteos('3')).toBe(false);
    expect(esSoloConteos([1])).toBe(false);
  });
  it('rechaza llaves que no sean identificadores (una llave también podría llevar un dato)', () => {
    expect(esSoloConteos({ 'mariana@correo.mx': 1 })).toBe(false);
    expect(esSoloConteos({ '528112345678': 1 })).toBe(false);
    expect(esSoloConteos({ R4_eventos_agregados: 2 })).toBe(true);
  });
  it('corta la profundidad para no aceptar estructuras arbitrarias', () => {
    expect(esSoloConteos({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toBe(true);
    expect(esSoloConteos({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toBe(false);
  });
});

describe('sumarConteos / totalConteos', () => {
  it('suma por llave, también anidado', () => {
    expect(sumarConteos({ a: 1, z: { b: 2 } }, { a: 2, z: { b: 1, c: 4 }, n: 1 })).toEqual({ a: 3, z: { b: 3, c: 4 }, n: 1 });
  });
  it('ignora valores no numéricos de dominios externos', () => {
    expect(sumarConteos({}, { a: 'x', b: 2 } as never)).toEqual({ b: 2 });
  });
  it('total recursivo', () => {
    expect(totalConteos({ a: 1, b: { c: 2, d: { e: 3 } } })).toBe(6);
    expect(totalConteos({})).toBe(0);
  });
});

describe('faltantes', () => {
  it('el orden de la política es captación, citas, comunicación, tracking, dashboard y el kernel (shared, al final)', () => {
    expect(DOMINIOS_RETENCION).toEqual(['captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'shared']);
  });
  it('devuelve los dominios sin función, en orden', () => {
    expect(faltantes(['tracking', 'captacion'])).toEqual(['citas', 'comunicacion', 'dashboard', 'shared']);
    expect(faltantes(DOMINIOS_RETENCION)).toEqual([]);
  });
});

describe('validarRegistro', () => {
  it('acepta un registro sin PII', () => {
    const r = validarRegistro({ tipo: 'retencion', reglas: ['captacion.retencion_aplicar'], conteos: { captacion: { leads: 1 } }, faltantes: [] });
    expect(r.ok).toBe(true);
  });
  it('rechaza reglas con texto libre o conteos con datos', () => {
    expect(validarRegistro({ tipo: 'retencion', reglas: ['borré a Mariana'], conteos: {}, faltantes: [] }).ok).toBe(false);
    expect(validarRegistro({ tipo: 'retencion', reglas: [], conteos: { tel: '8112345678' } as never, faltantes: [] }).ok).toBe(false);
    expect(validarRegistro({ tipo: 'otro' as never, reglas: [], conteos: {}, faltantes: [] }).ok).toBe(false);
    expect(validarRegistro({ tipo: 'arco', reglas: [], conteos: {}, faltantes: ['captacion; drop'] }).ok).toBe(false);
  });
});
