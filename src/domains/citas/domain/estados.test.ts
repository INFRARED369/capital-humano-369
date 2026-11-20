import { describe, expect, it } from 'vitest';
import { ESTADOS_ACTIVOS, ESTADOS_CITA, esTerminal, transicionar, type AccionCita, type EstadoCita } from './estados.ts';

describe('máquina de estados de la cita (CIT-07, C14)', () => {
  const validas: Array<[EstadoCita, AccionCita, EstadoCita]> = [
    ['retenida', 'confirmar', 'confirmada'],
    ['retenida', 'expirar', 'expirada'],
    ['retenida', 'liberar', 'expirada'],
    ['confirmada', 'marcar_asistio', 'asistio'],
    ['confirmada', 'marcar_no_asistio', 'no_asistio'],
    ['confirmada', 'cancelar', 'cancelada'],
    ['confirmada', 'reprogramar', 'reprogramada'],
  ];
  it.each(validas)('%s --%s--> %s', (de, accion, a) => {
    expect(transicionar(de, accion)).toEqual({ ok: true, value: a });
  });

  it('C14 · cancelada → asistió se rechaza', () => {
    expect(transicionar('cancelada', 'marcar_asistio')).toEqual({ ok: false, error: 'TRANSICION_INVALIDA' });
  });

  it('toda transición no listada se rechaza (matriz completa)', () => {
    const acciones: AccionCita[] = ['confirmar', 'expirar', 'liberar', 'marcar_asistio', 'marcar_no_asistio', 'cancelar', 'reprogramar'];
    for (const e of ESTADOS_CITA) {
      for (const a of acciones) {
        const permitida = validas.some(([de, ac]) => de === e && ac === a);
        expect(transicionar(e, a).ok, `${e} --${a}`).toBe(permitida);
      }
    }
  });

  it('estados terminales y activos', () => {
    expect(ESTADOS_CITA.filter(esTerminal)).toEqual(['asistio', 'no_asistio', 'cancelada', 'reprogramada', 'expirada']);
    expect(ESTADOS_ACTIVOS).toEqual(['retenida', 'confirmada']);
  });
});
