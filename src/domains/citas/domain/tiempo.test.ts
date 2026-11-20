import { describe, expect, it } from 'vitest';
import { diaSemanaIso, fechaLocal, horaLocal, isoLocalConOffset, localAUtc, sumarDias } from './tiempo.ts';

describe('tiempo · conversiones de zona horaria sin dependencias', () => {
  it('America/Mexico_City es UTC-6 todo el año (sin horario de verano desde 2022)', () => {
    expect(localAUtc('2026-11-17', '09:30', 'America/Mexico_City').toISOString()).toBe('2026-11-17T15:30:00.000Z');
    expect(localAUtc('2026-07-01', '09:30', 'America/Mexico_City').toISOString()).toBe('2026-07-01T15:30:00.000Z');
  });
  it('respeta zonas con horario de verano (reglas por vacante en otra zona)', () => {
    expect(localAUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(localAUtc('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });
  it('fecha y hora local de un instante UTC', () => {
    const d = new Date('2026-11-17T02:00:00Z');
    expect(fechaLocal(d, 'America/Mexico_City')).toBe('2026-11-16');
    expect(horaLocal(d, 'America/Mexico_City')).toBe('20:00');
    expect(isoLocalConOffset(new Date('2026-11-17T15:30:00Z'), 'America/Mexico_City')).toBe('2026-11-17T09:30:00-06:00');
    expect(isoLocalConOffset(new Date('2026-11-17T15:30:00Z'), 'UTC')).toBe('2026-11-17T15:30:00+00:00');
    expect(isoLocalConOffset(new Date('2026-11-17T15:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-17T21:00:00+05:30');
  });
  it('día de la semana ISO y suma de días', () => {
    expect(diaSemanaIso('2026-11-16')).toBe(1);
    expect(diaSemanaIso('2026-11-22')).toBe(7);
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
  });
});
