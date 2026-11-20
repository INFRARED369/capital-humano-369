import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { PLANTILLA_AGENDA_DEFECTO, ReglasAgendaSchema, type ReglasAgenda } from './reglas.ts';
import { generarSlots, puedeReservar, validarInicio, type CitaActiva } from './slots.ts';

// Lunes 16-nov-2026 20:00 en CDMX (02:00 UTC del martes).
const lunesNoche = () => new FixedClock(new Date('2026-11-17T02:00:00Z'));
const MARTES = '2026-11-17';
const reglas = (p: Partial<ReglasAgenda> = {}): ReglasAgenda => ReglasAgendaSchema.parse({ ...PLANTILLA_AGENDA_DEFECTO, ...p });
const utc = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`).toISOString();
const cita = (fecha: string, hhmm: string, minutos = 90): CitaActiva => {
  const inicio = utc(fecha, hhmm);
  return { inicio, fin: new Date(Date.parse(inicio) + minutos * 60_000).toISOString() };
};

describe('generarSlots', () => {
  it('C1 · plantilla por defecto, un martes: 13 inicios 9:30…13:00 y 15:00…17:00', () => {
    const slots = generarSlots(PLANTILLA_AGENDA_DEFECTO, [], lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(slots.map((s) => s.horaLocal)).toEqual([
      '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00',
      '15:00', '15:30', '16:00', '16:30', '17:00',
    ]);
    expect(slots.every((s) => s.capacidad === 1 && s.disponibles === 1)).toBe(true);
    expect(slots[0]).toEqual({
      inicio: '2026-11-17T15:30:00.000Z',
      fin: '2026-11-17T17:00:00.000Z',
      inicioLocal: '2026-11-17T09:30:00-06:00',
      fecha: MARTES,
      horaLocal: '09:30',
      capacidad: 1,
      disponibles: 1,
    });
  });

  it('C2 · sábado y domingo: lista vacía', () => {
    const slots = generarSlots(PLANTILLA_AGENDA_DEFECTO, [], lunesNoche());
    expect(slots.filter((s) => s.fecha === '2026-11-21' || s.fecha === '2026-11-22')).toEqual([]);
    // y un reloj en sábado con horizonte de 2 días (sáb y dom) no da nada
    const sab = new FixedClock(new Date('2026-11-21T15:00:00Z'));
    expect(generarSlots(reglas({ horizonte_dias: 2 }), [], sab)).toEqual([]);
  });

  it('C3 · vacante B con ventana 8:00–12:00, intervalo 60 y capacidad 3', () => {
    const b = reglas({ ventanas_inicio: [{ desde: '08:00', hasta: '12:00' }], intervalo_min: 60, capacidad_por_slot: 3 });
    const slots = generarSlots(b, [], lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(slots.map((s) => s.horaLocal)).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00']);
    expect(slots.every((s) => s.capacidad === 3 && s.disponibles === 3)).toBe(true);
  });

  it('C9 · los slots se expresan en la zona de la vacante y en UTC, sin importar la zona del navegador', () => {
    // El reloj es un instante absoluto; la zona del proceso no interviene.
    const slots = generarSlots(PLANTILLA_AGENDA_DEFECTO, [], lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(slots[0]!.inicio).toBe('2026-11-17T15:30:00.000Z');
    expect(slots[0]!.inicioLocal.endsWith('-06:00')).toBe(true);
    const enOtraZona = generarSlots(reglas({ zona_horaria: 'America/Bogota' }), [], lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(enOtraZona[0]!.inicio).toBe('2026-11-17T14:30:00.000Z'); // UTC-5
  });

  it('C10 · excluye festivos y bloqueos manuales', () => {
    const r = reglas({
      festivos: ['2026-11-18'],
      bloqueos: [{ desde: utc(MARTES, '10:00'), hasta: utc(MARTES, '12:00'), motivo: 'junta' }],
    });
    const slots = generarSlots(r, [], lunesNoche());
    expect(slots.some((s) => s.fecha === '2026-11-18')).toBe(false);
    expect(slots.filter((s) => s.fecha === MARTES).map((s) => s.horaLocal)).toEqual([
      '09:30', '12:00', '12:30', '13:00', '15:00', '15:30', '16:00', '16:30', '17:00',
    ]);
  });

  it('antelación mínima: no ofrece inicios antes de ahora + antelación', () => {
    const martes10 = new FixedClock(new Date(utc(MARTES, '10:05')));
    const slots = generarSlots(reglas({ antelacion_min_horas: 2 }), [], martes10).filter((s) => s.fecha === MARTES);
    expect(slots[0]!.horaLocal).toBe('12:30');
  });

  it('horizonte: no ofrece días más allá de horizonte_dias (contando hoy)', () => {
    const slots = generarSlots(reglas({ horizonte_dias: 3 }), [], lunesNoche());
    expect([...new Set(slots.map((s) => s.fecha))]).toEqual([MARTES, '2026-11-18']); // lunes ya pasó la antelación
  });

  it('descuenta la ocupación: slot lleno desaparece; día con cupo lleno desaparece', () => {
    const ocup = [cita(MARTES, '10:00')];
    const slots = generarSlots(PLANTILLA_AGENDA_DEFECTO, ocup, lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(slots.map((s) => s.horaLocal)).not.toContain('10:00');
    expect(slots).toHaveLength(12);

    const lleno = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '15:00', '15:30'].map((h) => cita(MARTES, h));
    expect(generarSlots(PLANTILLA_AGENDA_DEFECTO, lleno, lunesNoche()).filter((s) => s.fecha === MARTES)).toEqual([]);
  });

  it('disponibles = mínimo entre capacidad restante del slot y cupo restante del día', () => {
    const r = reglas({ capacidad_por_slot: 3, cupo_diario: 2 });
    const slots = generarSlots(r, [cita(MARTES, '09:30')], lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(slots.find((s) => s.horaLocal === '09:30')!.disponibles).toBe(1);
    expect(slots.find((s) => s.horaLocal === '10:00')!.disponibles).toBe(1);
  });

  it('sin empalmes: una cita de 90 min bloquea los inicios que se traslapan', () => {
    const r = reglas({ permitir_empalmes: false });
    const slots = generarSlots(r, [cita(MARTES, '10:00')], lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(slots.map((s) => s.horaLocal).slice(0, 3)).toEqual(['11:30', '12:00', '12:30']);
  });

  it('ventana que no cae en el intervalo: el último inicio es el último paso dentro de la ventana', () => {
    const r = reglas({ ventanas_inicio: [{ desde: '09:00', hasta: '10:45' }], intervalo_min: 30 });
    const slots = generarSlots(r, [], lunesNoche()).filter((s) => s.fecha === MARTES);
    expect(slots.map((s) => s.horaLocal)).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });
});

describe('puedeReservar', () => {
  const R = PLANTILLA_AGENDA_DEFECTO;

  it('C4 · 10:00 con 1 cita confirmada y capacidad 1 → SLOT_LLENO', () => {
    expect(puedeReservar(R, [cita(MARTES, '10:00')], utc(MARTES, '10:00'), lunesNoche())).toEqual({ ok: false, error: 'SLOT_LLENO' });
  });

  it('C5 · 10:00 ocupado, se reserva 10:30 → se permite', () => {
    const r = puedeReservar(R, [cita(MARTES, '10:00')], utc(MARTES, '10:30'), lunesNoche());
    expect(r).toEqual({ ok: true, value: { inicio: '2026-11-17T16:30:00.000Z', fin: '2026-11-17T18:00:00.000Z', fecha: MARTES } });
  });

  it('C6 · vacante con 10 citas en el día → CUPO_DIARIO', () => {
    const diez = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '15:00', '15:30'].map((h) => cita(MARTES, h));
    expect(puedeReservar(R, diez, utc(MARTES, '16:00'), lunesNoche())).toEqual({ ok: false, error: 'CUPO_DIARIO' });
  });

  it('C7 · la vacante A llena no afecta a la B el mismo día (ocupación por vacante)', () => {
    // La ocupación que recibe la función es solo la de la vacante consultada.
    expect(puedeReservar(R, [], utc(MARTES, '16:00'), lunesNoche()).ok).toBe(true);
  });

  it('C8 · cita 10:00 (1.5 h) y otro candidato reserva 10:30 → se permite (empalme)', () => {
    expect(puedeReservar(R, [cita(MARTES, '10:00')], utc(MARTES, '10:30'), lunesNoche()).ok).toBe(true);
    // con empalmes prohibidos se rechaza
    expect(puedeReservar(reglas({ permitir_empalmes: false }), [cita(MARTES, '10:00')], utc(MARTES, '10:30'), lunesNoche())).toEqual({ ok: false, error: 'SLOT_LLENO' });
  });

  it.each([
    ['fuera de ventana', utc(MARTES, '14:00')],
    ['fuera del paso de 30 min', utc(MARTES, '10:15')],
    ['sábado', utc('2026-11-21', '10:00')],
    ['en el pasado', utc('2026-11-16', '10:00')],
    ['más allá del horizonte', utc('2027-01-12', '10:00')],
    ['con segundos', '2026-11-17T16:00:01.000Z'],
    ['no es fecha', 'mañana'],
  ])('SLOT_INVALIDO si el inicio es %s', (_n, inicio) => {
    expect(puedeReservar(R, [], inicio, lunesNoche())).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
  });

  it('festivo y bloqueo → SLOT_INVALIDO', () => {
    const r = reglas({ festivos: [MARTES] });
    expect(validarInicio(r, utc(MARTES, '10:00'), lunesNoche())).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
    const b = reglas({ bloqueos: [{ desde: utc(MARTES, '09:00'), hasta: utc(MARTES, '18:00') }] });
    expect(validarInicio(b, utc(MARTES, '10:00'), lunesNoche()).ok).toBe(false);
  });

  it('acepta el inicio con offset local o en UTC (mismo instante)', () => {
    expect(validarInicio(R, '2026-11-17T10:00:00-06:00', lunesNoche()).ok).toBe(true);
    expect(validarInicio(R, '2026-11-17T16:00:00Z', lunesNoche()).ok).toBe(true);
  });
});
