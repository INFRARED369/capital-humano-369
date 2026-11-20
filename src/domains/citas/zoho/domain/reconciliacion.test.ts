import { describe, expect, it } from 'vitest';
import { construirEventoMinimo, type EventoCalendario } from './evento.ts';
import { decidirReconciliacion, type EsperadoZoho } from './reconciliacion.ts';
import type { EventoRemoto } from './tipos.ts';

const cfg = { panelUrl: 'https://panel.369.mx', zonaHoraria: 'America/Mexico_City' };
const id = (n: number) => `0192f5a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function evento(n: number, inicio = '2026-11-16T16:00:00.000Z'): EventoCalendario {
  const fin = new Date(Date.parse(inicio) + 30 * 60_000).toISOString();
  const r = construirEventoMinimo({ citaId: id(n), folio: `V-${n}`, nombrePila: 'Ana', inicio, fin }, cfg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const remotoDe = (e: EventoCalendario, uid: string, over: Partial<EventoRemoto> = {}): EventoRemoto => ({
  uid, etag: '10', titulo: e.titulo, descripcion: e.descripcion, inicio: e.inicio, fin: e.fin, uidPropio: e.uidPropio, numAsistentes: 0, ...over,
});

describe('decidirReconciliacion (CIT-09, Z5): el sistema gana', () => {
  it('todo coincide → sin acciones', () => {
    const e = evento(1);
    const esperados: EsperadoZoho[] = [{ citaId: id(1), zohoEventUid: 'z1', evento: e }];
    expect(decidirReconciliacion(esperados, [remotoDe(e, 'z1')])).toEqual([]);
  });

  it('evento borrado a mano en Zoho → recrear', () => {
    const e = evento(1);
    expect(decidirReconciliacion([{ citaId: id(1), zohoEventUid: 'z1', evento: e }], [])).toEqual([
      { tipo: 'recrear', citaId: id(1), motivo: 'borrado_en_zoho' },
    ]);
  });

  it('esperado sin uid de Zoho y sin remoto → recrear por pendiente', () => {
    const e = evento(1);
    expect(decidirReconciliacion([{ citaId: id(1), zohoEventUid: null, evento: e }], [])).toEqual([
      { tipo: 'recrear', citaId: id(1), motivo: 'no_publicado' },
    ]);
  });

  it('encuentra por UID propio si el uid de Zoho no se guardó → adoptar', () => {
    const e = evento(1);
    expect(decidirReconciliacion([{ citaId: id(1), zohoEventUid: null, evento: e }], [remotoDe(e, 'z9')])).toEqual([
      { tipo: 'adoptar', citaId: id(1), zohoEventUid: 'z9' },
    ]);
  });

  it('evento editado a mano (horario o asistentes) → corregir con su etag', () => {
    const e = evento(1);
    const acciones = decidirReconciliacion(
      [{ citaId: id(1), zohoEventUid: 'z1', evento: e }],
      [remotoDe(e, 'z1', { inicio: '2026-11-16T18:00:00Z', numAsistentes: 2, etag: '77' })],
    );
    expect(acciones).toEqual([{ tipo: 'corregir', citaId: id(1), zohoEventUid: 'z1', etag: '77', campos: ['inicio', 'asistentes'] }]);
  });

  it('evento nuestro (con marcador) sin cita vigente → borrar huérfano', () => {
    const e = evento(2);
    expect(decidirReconciliacion([], [remotoDe(e, 'z2')])).toEqual([
      { tipo: 'borrar', zohoEventUid: 'z2', etag: '10', uidPropio: e.uidPropio },
    ]);
  });

  it('ignora eventos ajenos (sin marcador del sistema)', () => {
    const e = evento(3);
    expect(decidirReconciliacion([], [remotoDe(e, 'z3', { uidPropio: null })])).toEqual([]);
  });

  it('dos remotos con el mismo marcador → se conserva uno y el duplicado se borra', () => {
    const e = evento(1);
    const acciones = decidirReconciliacion([{ citaId: id(1), zohoEventUid: 'z1', evento: e }], [remotoDe(e, 'z1'), remotoDe(e, 'zdup')]);
    expect(acciones).toEqual([{ tipo: 'borrar', zohoEventUid: 'zdup', etag: '10', uidPropio: e.uidPropio }]);
  });
});
