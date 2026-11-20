import { describe, expect, it } from 'vitest';
import { FOLIO_RE, VENTANA_DEDUPE_DIAS, decidirDedupe, generarFolio, inicioVentanaDedupe, nombrePila } from './lead.ts';

describe('folio (CAP-06)', () => {
  it('formato 369-XXXXXX sin caracteres ambiguos', () => {
    for (let i = 0; i < 200; i++) {
      const f = generarFolio();
      expect(f).toMatch(FOLIO_RE);
      expect(f.slice(4)).not.toMatch(/[01OI]/);
    }
  });
  it('es determinista con una fuente aleatoria fija', () => {
    const r = () => new Uint8Array([0, 0, 0, 0]);
    expect(generarFolio(r)).toBe('369-AAAAAA');
  });
});

describe('nombre de pila', () => {
  it.each([
    ['mariana garza', 'Mariana'],
    ['  JOSÉ  luis ', 'José'],
    ['Ñoño', 'Ñoño'],
  ])('%s → %s', (n, e) => expect(nombrePila(n)).toBe(e));
});

describe('deduplicación (CAP-07, P5)', () => {
  const ahora = new Date('2026-11-16T15:00:00Z');
  it('ventana de 30 días', () => {
    expect(VENTANA_DEDUPE_DIAS).toBe(30);
    expect(inicioVentanaDedupe(ahora).toISOString()).toBe('2026-10-17T15:00:00.000Z');
  });
  it('sin lead previo → nuevo', () => {
    expect(decidirDedupe(null)).toEqual({ accion: 'crear' });
  });
  it('lead pendiente o bloqueado → reutilizar', () => {
    expect(decidirDedupe({ id: 'l1', estado: 'pendiente_otp' })).toEqual({ accion: 'reutilizar', leadId: 'l1' });
    expect(decidirDedupe({ id: 'l1', estado: 'otp_bloqueado' })).toEqual({ accion: 'reutilizar', leadId: 'l1' });
  });
  it('lead ya verificado (cita confirmada) → ya postulado', () => {
    expect(decidirDedupe({ id: 'l1', estado: 'verificado' })).toEqual({ accion: 'ya_postulado', leadId: 'l1' });
  });
});
