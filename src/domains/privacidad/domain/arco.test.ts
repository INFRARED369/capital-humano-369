/** Solicitudes ARCO y revocación (PRV-02, Política §3). */
import { describe, expect, it } from 'vitest';
import { ESTADOS_ARCO, TIPOS_ARCO, requiereSupresion, transicionArco, vencimiento } from './arco.ts';

describe('tipos y supresión', () => {
  it('cancelación, oposición y revocación suprimen al instante; acceso y rectificación se atienden a mano', () => {
    expect(TIPOS_ARCO).toEqual(['acceso', 'rectificacion', 'cancelacion', 'oposicion', 'revocacion']);
    expect(TIPOS_ARCO.filter(requiereSupresion)).toEqual(['cancelacion', 'oposicion', 'revocacion']);
  });
});

describe('transicionArco', () => {
  it('recibida → ejecutada (solo tipos que suprimen)', () => {
    expect(transicionArco('recibida', 'ejecutar', 'cancelacion')).toEqual({ ok: true, value: 'ejecutada' });
    expect(transicionArco('recibida', 'ejecutar', 'acceso')).toEqual({ ok: false, error: 'TIPO_NO_EJECUTABLE' });
  });
  it('recibida → respondida | rechazada', () => {
    expect(transicionArco('recibida', 'responder', 'acceso')).toEqual({ ok: true, value: 'respondida' });
    expect(transicionArco('recibida', 'rechazar', 'cancelacion')).toEqual({ ok: true, value: 'rechazada' });
  });
  it('los estados finales son terminales', () => {
    for (const e of ['ejecutada', 'respondida', 'rechazada'] as const) {
      for (const a of ['ejecutar', 'responder', 'rechazar'] as const) {
        expect(transicionArco(e, a, 'cancelacion')).toEqual({ ok: false, error: 'TRANSICION_INVALIDA' });
      }
    }
    expect(ESTADOS_ARCO).toEqual(['recibida', 'ejecutada', 'respondida', 'rechazada']);
  });
});

describe('vencimiento', () => {
  it('marca vencida la respuesta pasada la fecha límite (fecha local)', () => {
    const s = { estado: 'recibida' as const, limiteRespuesta: '2026-12-15', limiteEjecucion: '2027-01-07' };
    expect(vencimiento(s, new Date('2026-12-15T23:00:00Z'))).toBe('por_vencer'); // 17:00 local del día límite
    expect(vencimiento(s, new Date('2026-12-16T07:00:00Z'))).toBe('respuesta_vencida');
  });
  it('estados cerrados no vencen', () => {
    expect(vencimiento({ estado: 'ejecutada', limiteRespuesta: '2020-01-01', limiteEjecucion: '2020-01-01' }, new Date())).toBe('cerrada');
  });
  it('por vencer: 3 días hábiles o menos', () => {
    const s = { estado: 'recibida' as const, limiteRespuesta: '2026-12-15', limiteEjecucion: '2027-01-07' };
    expect(vencimiento(s, new Date('2026-12-10T18:00:00Z'))).toBe('por_vencer');
    expect(vencimiento(s, new Date('2026-12-01T18:00:00Z'))).toBe('en_plazo');
  });
});
