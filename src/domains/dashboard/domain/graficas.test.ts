import { describe, expect, it } from 'vitest';
import { escalaBarras, formatoMxn, formatoPct, formatoNumero } from './graficas.ts';

describe('escalaBarras: proporciones 0..1 para barras accesibles', () => {
  it('normaliza contra el máximo (o un máximo dado)', () => {
    expect(escalaBarras([0, 5, 10])).toEqual([0, 0.5, 1]);
    expect(escalaBarras([2, 4], 8)).toEqual([0.25, 0.5]);
  });
  it('todo en cero, vacío o valores inválidos → 0', () => {
    expect(escalaBarras([0, 0])).toEqual([0, 0]);
    expect(escalaBarras([])).toEqual([]);
    expect(escalaBarras([Number.NaN, -3, 4])).toEqual([0, 0, 1]);
  });
});

describe('formatos es-MX', () => {
  it('moneda, porcentaje y número; null → "—"', () => {
    expect(formatoMxn(1234.5)).toMatch(/1,234\.50/);
    expect(formatoPct(0.256)).toBe('25.6 %');
    expect(formatoNumero(12345)).toBe('12,345');
    expect(formatoMxn(null)).toBe('—');
    expect(formatoPct(null)).toBe('—');
  });
});
