import { describe, expect, it } from 'vitest';
import { estadoInicial, reducir } from './flujo';
import { VIGENCIA_AVANCE_MS, borrarAvance, guardarAvance, hayAvance, interpretarAvance, leerAvance, llaveAvance, type Avance } from './persistencia';

function almacenFalso(lanza = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => { if (lanza) throw new Error('bloqueado'); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (lanza) throw new Error('cuota'); m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

const T0 = Date.parse('2026-11-19T18:00:00Z');
const avance = (cambios: Partial<Avance> = {}): Avance => ({
  estado: { ...estadoInicial, paso: 'otp', leadId: 'lead-1', folio: '369-ABCDEF', expiraEn: '2026-11-19T18:10:00Z', reenviosRestantes: 2, canal: 'sms' },
  valores: { nombre: 'Ana López', telefono: '8112345678', email: 'ana@correo.mx', respuestas: { edad: '22', turno: 'matutino' } },
  consentido: true,
  canal: 'sms',
  dia: '2026-11-20',
  slot: '2026-11-20T16:00:00.000Z',
  ...cambios,
});

describe('avance del candidato (recarga → mismo paso y mismos datos)', () => {
  it('guarda y recupera paso, datos, canal, día y hora', () => {
    const a = almacenFalso();
    guardarAvance('agente-smart', avance(), T0, a);
    expect(leerAvance('agente-smart', T0 + 60_000, a)).toEqual(avance());
    expect(a.m.has(llaveAvance('agente-smart'))).toBe(true);
    // Otra vacante no ve este avance.
    expect(leerAvance('otra-vacante', T0, a)).toBeNull();
  });
  it('no guarda token anti-bot ni código OTP', () => {
    const a = almacenFalso();
    guardarAvance('agente-smart', avance(), T0, a);
    const crudo = a.m.get(llaveAvance('agente-smart'))!;
    expect(crudo).not.toMatch(/turnstile|codigo"/i);
  });
  it('vence a las 2 horas y lo borra', () => {
    const a = almacenFalso();
    guardarAvance('agente-smart', avance(), T0, a);
    expect(leerAvance('agente-smart', T0 + VIGENCIA_AVANCE_MS + 1, a)).toBeNull();
    expect(a.m.size).toBe(0);
  });
  it('descarta datos alterados, de otra versión o JSON inválido', () => {
    expect(interpretarAvance('{no json', T0)).toBeNull();
    expect(interpretarAvance(JSON.stringify({ ...avance(), v: 99, guardadoEn: T0 }), T0)).toBeNull();
    expect(interpretarAvance(JSON.stringify({ ...avance({ canal: 'fax' as never }), v: 1, guardadoEn: T0 }), T0)).toBeNull();
    expect(interpretarAvance(JSON.stringify({ ...avance(), estado: { ...avance().estado, paso: 'hackeado' }, v: 1, guardadoEn: T0 }), T0)).toBeNull();
    expect(interpretarAvance(JSON.stringify({ ...avance(), valores: { ...avance().valores, respuestas: { edad: 22 } }, v: 1, guardadoEn: T0 }), T0)).toBeNull();
  });
  it('OTP o pase sin lead → vuelve al formulario conservando los datos', () => {
    const r = interpretarAvance(JSON.stringify({ ...avance({ estado: { ...avance().estado, leadId: null } }), v: 1, guardadoEn: T0 }), T0);
    expect(r?.estado.paso).toBe('formulario');
    expect(r?.valores.nombre).toBe('Ana López');
  });
  it('sin almacenamiento (modo privado / bloqueado) no rompe el flujo', () => {
    const a = almacenFalso(true);
    expect(() => guardarAvance('agente-smart', avance(), T0, a)).not.toThrow();
    expect(leerAvance('agente-smart', T0, a)).toBeNull();
    expect(() => borrarAvance('agente-smart', a)).not.toThrow();
    expect(leerAvance('agente-smart', T0, null)).toBeNull();
  });
  it('un formulario vacío en el primer paso no cuenta como avance', () => {
    const vacio = avance({ estado: estadoInicial, valores: { nombre: '', telefono: '', email: '', respuestas: {} }, consentido: false });
    expect(hayAvance(vacio)).toBe(false);
    expect(hayAvance({ ...vacio, valores: { ...vacio.valores, nombre: 'A' } })).toBe(true);
    expect(hayAvance(avance())).toBe(true);
  });
  it("el reducer 'restaurar' reemplaza el estado completo", () => {
    const e = avance().estado;
    expect(reducir(estadoInicial, { tipo: 'restaurar', estado: e })).toEqual(e);
  });
});
