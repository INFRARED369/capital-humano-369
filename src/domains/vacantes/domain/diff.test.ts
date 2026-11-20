import { describe, expect, it } from 'vitest';
import { diffReglas } from './diff.ts';

describe('diffReglas (S4, NFR-SEG-09): mismo formato que config.diff_jsonb', () => {
  it('sin cambios → []', () => {
    expect(diffReglas({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
  });

  it('reporta hojas con ruta punteada, ordenadas; los arreglos son hojas', () => {
    expect(
      diffReglas(
        { agenda: { cupo_diario: 10, ventanas_inicio: [{ desde: '09:30', hasta: '13:00' }, { desde: '15:00', hasta: '17:00' }] }, z: 1 },
        { agenda: { cupo_diario: 5, ventanas_inicio: [{ desde: '09:30', hasta: '13:00' }] }, z: 1 },
      ),
    ).toEqual([
      { ruta: 'agenda.cupo_diario', antes: 10, despues: 5 },
      { ruta: 'agenda.ventanas_inicio', antes: [{ desde: '09:30', hasta: '13:00' }, { desde: '15:00', hasta: '17:00' }], despues: [{ desde: '09:30', hasta: '13:00' }] },
    ]);
  });

  it('una llave que aparece o desaparece se reporta contra null; un objeto ausente se trata como {}', () => {
    expect(diffReglas({}, { zoho_calendar_uid: 'cal-1', agenda: { cupo_diario: 3 } })).toEqual([
      { ruta: 'agenda.cupo_diario', antes: null, despues: 3 },
      { ruta: 'zoho_calendar_uid', antes: null, despues: 'cal-1' },
    ]);
    expect(diffReglas({ zoho_calendar_uid: 'cal-1' }, {})).toEqual([{ ruta: 'zoho_calendar_uid', antes: 'cal-1', despues: null }]);
    expect(diffReglas(null, null)).toEqual([]);
  });

  it('cambio de tipo (objeto → escalar) es una hoja', () => {
    expect(diffReglas({ a: { b: 1 } }, { a: 2 })).toEqual([{ ruta: 'a', antes: { b: 1 }, despues: 2 }]);
  });

  it('la igualdad de objetos dentro de arreglos no depende del orden de las llaves', () => {
    expect(diffReglas({ x: [{ a: 1, b: 2 }] }, { x: [{ b: 2, a: 1 }] })).toEqual([]);
  });
});
