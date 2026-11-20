/** Días hábiles (México) y plazos ARCO: 20 días hábiles para responder y el plazo siguiente para ejecutar. */
import { describe, expect, it } from 'vitest';
import { esDiaHabil, festivosMexico, fechaLocal, plazosArco, sumarDiasHabiles, PLAZO_RESPUESTA_DIAS_HABILES, PLAZO_EJECUCION_DIAS_HABILES } from './plazos.ts';

describe('festivosMexico (LFT art. 74)', () => {
  it('2026: fechas fijas y lunes móviles', () => {
    expect([...festivosMexico(2026)].sort()).toEqual([
      '2026-01-01', '2026-02-02', '2026-03-16', '2026-05-01', '2026-09-16', '2026-11-16', '2026-12-25',
    ]);
  });
  it('1 de octubre solo en años de transmisión del Ejecutivo federal (2030, 2036…)', () => {
    expect(festivosMexico(2030).has('2030-10-01')).toBe(true);
    expect(festivosMexico(2027).has('2027-10-01')).toBe(false);
    expect(festivosMexico(2024).has('2024-10-01')).toBe(true);
  });
});

describe('fechaLocal', () => {
  it('convierte a la fecha civil de America/Mexico_City (UTC-6)', () => {
    expect(fechaLocal(new Date('2026-11-18T05:59:00Z'))).toBe('2026-11-17');
    expect(fechaLocal(new Date('2026-11-18T06:00:00Z'))).toBe('2026-11-18');
  });
});

describe('esDiaHabil', () => {
  it('sábado, domingo y festivo no son hábiles', () => {
    expect(esDiaHabil('2026-11-14')).toBe(false); // sábado
    expect(esDiaHabil('2026-11-15')).toBe(false); // domingo
    expect(esDiaHabil('2026-11-16')).toBe(false); // revolución (tercer lunes)
    expect(esDiaHabil('2026-11-17')).toBe(true);
  });
  it('acepta días inhábiles adicionales (p. ej. los que publique la autoridad)', () => {
    expect(esDiaHabil('2026-11-17', ['2026-11-17'])).toBe(false);
  });
});

describe('sumarDiasHabiles', () => {
  it('cuenta desde el día hábil siguiente a la recepción', () => {
    // martes 17-nov-2026 + 1 hábil = miércoles 18
    expect(sumarDiasHabiles(new Date('2026-11-17T18:00:00Z'), 1)).toBe('2026-11-18');
    // viernes 13-nov + 1 = martes 17 (sábado, domingo y lunes festivo)
    expect(sumarDiasHabiles(new Date('2026-11-13T18:00:00Z'), 1)).toBe('2026-11-17');
  });
  it('20 días hábiles cruzando Navidad y Año Nuevo', () => {
    // recibida lunes 14-dic-2026 → 15,16,17,18 | 21,22,23,24 | 28,29,30,31 | 4..8 ene | 11,12,13 → 13-ene-2027
    expect(sumarDiasHabiles(new Date('2026-12-14T17:00:00Z'), 20)).toBe('2027-01-13');
  });
  it('recepción en fin de semana: igual cuenta desde el siguiente hábil', () => {
    expect(sumarDiasHabiles(new Date('2026-11-21T17:00:00Z'), 1)).toBe('2026-11-23');
  });
  it('rechaza n negativo o no entero', () => {
    expect(() => sumarDiasHabiles(new Date(), -1)).toThrow(RangeError);
    expect(() => sumarDiasHabiles(new Date(), 1.5)).toThrow(RangeError);
  });
  it('n = 0 devuelve la fecha local de recepción', () => {
    expect(sumarDiasHabiles(new Date('2026-11-17T18:00:00Z'), 0)).toBe('2026-11-17');
  });
});

describe('plazosArco', () => {
  it('respuesta a 20 días hábiles y ejecución en el plazo siguiente (15 hábiles)', () => {
    expect(PLAZO_RESPUESTA_DIAS_HABILES).toBe(20);
    expect(PLAZO_EJECUCION_DIAS_HABILES).toBe(15);
    const p = plazosArco(new Date('2026-11-17T18:00:00Z'));
    // 18,19,20 | 23..27 | 30, 1..4 dic | 7..11 | 14,15 → 15-dic
    expect(p.limiteRespuesta).toBe('2026-12-15');
    // desde 15-dic: 16,17,18 | 21..24 | 28..31 | 4..7 ene → 7-ene-2027 (15 hábiles; 25-dic y 1-ene inhábiles)
    expect(p.limiteEjecucion).toBe('2027-01-07');
  });
  it('días inhábiles adicionales recorren los plazos', () => {
    const base = plazosArco(new Date('2026-11-17T18:00:00Z'));
    const conInhabil = plazosArco(new Date('2026-11-17T18:00:00Z'), { inhabiles: ['2026-11-18'] });
    expect(conInhabil.limiteRespuesta > base.limiteRespuesta).toBe(true);
  });
});
