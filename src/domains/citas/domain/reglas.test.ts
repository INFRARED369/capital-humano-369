import { describe, expect, it } from 'vitest';
import { PLANTILLA_AGENDA_DEFECTO, ReglasAgendaSchema, extraerReglasAgenda } from './reglas.ts';

describe('ReglasAgendaSchema · plantilla por defecto (D1–D3, reglas de reservas)', () => {
  it('la plantilla es válida y refleja las reglas de negocio', () => {
    const r = ReglasAgendaSchema.parse(PLANTILLA_AGENDA_DEFECTO);
    expect(r).toEqual(PLANTILLA_AGENDA_DEFECTO);
    expect(r.zona_horaria).toBe('America/Mexico_City');
    expect(r.dias_habiles).toEqual([1, 2, 3, 4, 5]);
    expect(r.ventanas_inicio).toEqual([
      { desde: '09:30', hasta: '13:00' },
      { desde: '15:00', hasta: '17:00' },
    ]);
    expect(r.intervalo_min).toBe(30);
    expect(r.capacidad_por_slot).toBe(1);
    expect(r.cupo_diario).toBe(10);
    expect(r.duracion_cita_min).toBe(90);
    expect(r.permitir_empalmes).toBe(true);
    expect(r.ttl_retencion_min).toBe(10);
    expect(r.festivos).toEqual([]);
    expect(r.bloqueos).toEqual([]);
  });

  it('un objeto vacío toma los valores de la plantilla (campos con default)', () => {
    expect(ReglasAgendaSchema.parse({})).toEqual(PLANTILLA_AGENDA_DEFECTO);
  });

  it('la plantilla está congelada (nadie la muta por accidente)', () => {
    expect(Object.isFrozen(PLANTILLA_AGENDA_DEFECTO)).toBe(true);
  });

  it.each([
    ['zona inválida', { zona_horaria: 'Marte/Olimpo' }],
    ['día fuera de rango', { dias_habiles: [0] }],
    ['días repetidos', { dias_habiles: [1, 1] }],
    ['hora mal formada', { ventanas_inicio: [{ desde: '9:30', hasta: '13:00' }] }],
    ['ventana invertida', { ventanas_inicio: [{ desde: '13:00', hasta: '09:00' }] }],
    ['intervalo 0', { intervalo_min: 0 }],
    ['capacidad 0', { capacidad_por_slot: 0 }],
    ['cupo negativo', { cupo_diario: -1 }],
    ['festivo mal formado', { festivos: ['2026-13-40'] }],
    ['bloqueo invertido', { bloqueos: [{ desde: '2026-11-17T12:00:00Z', hasta: '2026-11-17T10:00:00Z' }] }],
    ['ttl excesivo', { ttl_retencion_min: 24 * 60 }],
    ['campo desconocido', { otra_cosa: 1 }],
  ])('rechaza %s', (_n, parcial) => {
    expect(ReglasAgendaSchema.safeParse(parcial).success).toBe(false);
  });

  it('acepta reglas alternativas por vacante (C3)', () => {
    const r = ReglasAgendaSchema.parse({ ventanas_inicio: [{ desde: '08:00', hasta: '12:00' }], intervalo_min: 60, capacidad_por_slot: 3 });
    expect(r.capacidad_por_slot).toBe(3);
    expect(r.cupo_diario).toBe(10);
  });
});

describe('extraerReglasAgenda · JSON de config.vacantes_reglas = { agenda, ... }', () => {
  it('sin versión usa la plantilla y versión 0', () => {
    expect(extraerReglasAgenda(null)).toEqual({ ok: true, value: { version: 0, agenda: PLANTILLA_AGENDA_DEFECTO } });
  });
  it('lee la sección agenda e ignora el resto (mensajes, zoho…)', () => {
    const r = extraerReglasAgenda({ version: 4, reglas: { agenda: { cupo_diario: 5 }, mensajes: {}, zoho_calendar_uid: 'x' } });
    expect(r.ok && r.value.version).toBe(4);
    expect(r.ok && r.value.agenda.cupo_diario).toBe(5);
  });
  it('sin sección agenda usa la plantilla con la versión indicada', () => {
    const r = extraerReglasAgenda({ version: 2, reglas: {} });
    expect(r).toEqual({ ok: true, value: { version: 2, agenda: PLANTILLA_AGENDA_DEFECTO } });
  });
  it('agenda inválida → error REGLAS_INVALIDAS (no se adivina)', () => {
    expect(extraerReglasAgenda({ version: 1, reglas: { agenda: { cupo_diario: 'x' } } })).toEqual({ ok: false, error: 'REGLAS_INVALIDAS' });
  });
});
