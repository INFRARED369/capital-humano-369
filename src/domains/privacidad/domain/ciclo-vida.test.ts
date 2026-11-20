/** Ciclo de vida del lead (Política §1.2 y §2): activo → bloqueo (30 días, solo admin) → anonimización. */
import { describe, expect, it } from 'vitest';
import { calcularPlazos, ETAPAS, estadoEn, etapaTrasEvento, PLAZOS_POLITICA, referenciaEntrega } from './ciclo-vida.ts';

const DIA = 86_400_000;
const inicio = new Date('2026-09-01T16:00:00Z');

describe('calcularPlazos', () => {
  it('cancelada o no asistió: cita + 30 días activo, + 30 de bloqueo', () => {
    for (const etapa of ['cita_cancelada', 'no_asistio', 'cita_confirmada'] as const) {
      const p = calcularPlazos(etapa, inicio);
      expect(p.finActivo.getTime() - inicio.getTime()).toBe(30 * DIA);
      expect(p.finBloqueo.getTime() - inicio.getTime()).toBe(60 * DIA);
      expect(p.accion).toBe('anonimizar');
    }
  });
  it('asistió: cita + 90 días activo, + 30 de bloqueo', () => {
    const p = calcularPlazos('asistio', inicio);
    expect(p.finActivo.getTime() - inicio.getTime()).toBe(90 * DIA);
    expect(p.finBloqueo.getTime() - inicio.getTime()).toBe(120 * DIA);
  });
  it('sin verificar: 48 h y sin bloqueo; la acción es supresión (la ejecuta captación)', () => {
    const p = calcularPlazos('sin_verificar', inicio);
    expect(p.finActivo.getTime() - inicio.getTime()).toBe(48 * 3_600_000);
    expect(p.finBloqueo).toEqual(p.finActivo);
    expect(p.accion).toBe('suprimir');
  });
  it('verificado sin cita (agenda por WhatsApp): 30 + 30 días (decisión pendiente Q-3)', () => {
    const p = calcularPlazos('verificado', inicio);
    expect(p.finBloqueo.getTime() - inicio.getTime()).toBe(60 * DIA);
  });
  it('contratado: hasta la entrega al cliente, máx. 30 días desde la contratación, + 30 de bloqueo', () => {
    const p = calcularPlazos('contratado', inicio);
    expect(p.finActivo.getTime() - inicio.getTime()).toBe(30 * DIA);
    expect(p.finBloqueo.getTime() - inicio.getTime()).toBe(60 * DIA);
    expect(p.accion).toBe('anonimizar');
  });
  it('entregado: el plazo activo termina con la entrega; bloqueo de 30 días desde ahí', () => {
    const p = calcularPlazos('entregado', inicio);
    expect(p.finActivo).toEqual(inicio);
    expect(p.finBloqueo.getTime() - inicio.getTime()).toBe(30 * DIA);
  });
  it('referenciaEntrega: la entrega tardía no alarga el máximo de 30 días', () => {
    const contratado = inicio;
    expect(referenciaEntrega(contratado, new Date(inicio.getTime() + 5 * DIA))).toEqual(new Date(inicio.getTime() + 5 * DIA));
    expect(referenciaEntrega(contratado, new Date(inicio.getTime() + 45 * DIA))).toEqual(new Date(inicio.getTime() + 30 * DIA));
    expect(referenciaEntrega(null, new Date(inicio.getTime() + 45 * DIA))).toEqual(new Date(inicio.getTime() + 45 * DIA));
  });
  it('todas las etapas tienen plazo y coinciden con la tabla exportada', () => {
    for (const e of ETAPAS) expect(PLAZOS_POLITICA[e]).toBeDefined();
  });
});

describe('estadoEn', () => {
  const p = calcularPlazos('no_asistio', inicio);
  it('activo antes de fin_activo, bloqueado hasta fin_bloqueo y vencido después', () => {
    expect(estadoEn(p, new Date(inicio.getTime() + 29 * DIA))).toBe('activo');
    expect(estadoEn(p, new Date(inicio.getTime() + 30 * DIA))).toBe('bloqueado');
    expect(estadoEn(p, new Date(inicio.getTime() + 59 * DIA))).toBe('bloqueado');
    expect(estadoEn(p, new Date(inicio.getTime() + 60 * DIA))).toBe('vencido');
  });
});

describe('etapaTrasEvento', () => {
  it('sigue los eventos del outbox', () => {
    expect(etapaTrasEvento(null, { tipo: 'LeadCreado' })).toBe('sin_verificar');
    expect(etapaTrasEvento('sin_verificar', { tipo: 'WhatsAppVerificado' })).toBe('verificado');
    expect(etapaTrasEvento('verificado', { tipo: 'CitaConfirmada' })).toBe('cita_confirmada');
    expect(etapaTrasEvento('cita_confirmada', { tipo: 'CitaReprogramada' })).toBe('cita_confirmada');
    expect(etapaTrasEvento('cita_confirmada', { tipo: 'CitaCancelada', motivo: 'candidato' })).toBe('cita_cancelada');
    expect(etapaTrasEvento('cita_confirmada', { tipo: 'AsistenciaRegistrada', asistio: true })).toBe('asistio');
    expect(etapaTrasEvento('cita_confirmada', { tipo: 'AsistenciaRegistrada', asistio: false })).toBe('no_asistio');
  });
  it('no retrocede: WhatsAppVerificado tardío no borra una cita confirmada; LeadCreado repetido no reinicia', () => {
    expect(etapaTrasEvento('cita_confirmada', { tipo: 'WhatsAppVerificado' })).toBe('cita_confirmada');
    expect(etapaTrasEvento('asistio', { tipo: 'LeadCreado' })).toBe('asistio');
  });
  it('LeadContratado: contratado → entregado; una contratación repetida no deshace la entrega', () => {
    expect(etapaTrasEvento('asistio', { tipo: 'LeadContratado', entregado: false })).toBe('contratado');
    expect(etapaTrasEvento('contratado', { tipo: 'LeadContratado', entregado: true })).toBe('entregado');
    expect(etapaTrasEvento('asistio', { tipo: 'LeadContratado', entregado: true })).toBe('entregado');
    expect(etapaTrasEvento('entregado', { tipo: 'LeadContratado', entregado: false })).toBe('entregado');
    expect(etapaTrasEvento('entregado', { tipo: 'WhatsAppVerificado' })).toBe('entregado');
  });
  it('una cancelación por supresión no cambia la etapa (el lead se está borrando)', () => {
    expect(etapaTrasEvento('cita_confirmada', { tipo: 'CitaCancelada', motivo: 'supresion' })).toBe('cita_confirmada');
  });
  it('CitaConfirmada sin LeadCreado previo (consumidor tardío) igual crea la etapa', () => {
    expect(etapaTrasEvento(null, { tipo: 'CitaConfirmada' })).toBe('cita_confirmada');
    expect(etapaTrasEvento(null, { tipo: 'WhatsAppVerificado' })).toBe('verificado');
  });
});
