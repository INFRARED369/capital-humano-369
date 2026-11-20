/**
 * Ciclo de vida de los datos del lead (Política §1.2 y §2). Puro, sin I/O.
 *   activo → bloqueado (30 días, solo admin) → anonimización irreversible.
 * La etapa se deriva de los eventos del outbox (regla 2 de CONTRATOS); privacidad no lee tablas ajenas.
 * Debe coincidir con `privacidad.plazos_ciclo` (SQL); la paridad la verifica privacidad.db.test.ts.
 */
export const ETAPAS = ['sin_verificar', 'verificado', 'cita_confirmada', 'cita_cancelada', 'no_asistio', 'asistio', 'contratado', 'entregado'] as const;
export type Etapa = (typeof ETAPAS)[number];
export type Accion = 'suprimir' | 'anonimizar';

const HORA = 3_600_000;
const DIA = 24 * HORA;
export const BLOQUEO_MS = 30 * DIA;

/**
 * - sin_verificar: 48 h y supresión total. La ejecuta captación (`retencion_aplicar`); privacidad solo propaga.
 * - verificado sin cita (vacantes con agenda por WhatsApp): la política no lo cubre; se usa 30 + 30 días
 *   desde la verificación (decisión pendiente, Q-3).
 * - cita confirmada sin asistencia registrada, cancelada o no asistió: cita + 30 días (+30 de bloqueo).
 * - asistió: cita + 90 días (+30 de bloqueo).
 * - contratado (LeadContratado sin entrega): "hasta la entrega al cliente (máx. 30 días)": contratación + 30 días (+30).
 * - entregado (LeadContratado con `entregado_en`): el plazo activo termina con la entrega → bloqueo de 30 días.
 *   La referencia es `referenciaEntrega` (una entrega tardía no alarga el máximo de 30 días).
 */
export const PLAZOS_POLITICA: Record<Etapa, { activoMs: number; bloqueoMs: number; accion: Accion }> = {
  sin_verificar: { activoMs: 48 * HORA, bloqueoMs: 0, accion: 'suprimir' },
  verificado: { activoMs: 30 * DIA, bloqueoMs: BLOQUEO_MS, accion: 'anonimizar' },
  cita_confirmada: { activoMs: 30 * DIA, bloqueoMs: BLOQUEO_MS, accion: 'anonimizar' },
  cita_cancelada: { activoMs: 30 * DIA, bloqueoMs: BLOQUEO_MS, accion: 'anonimizar' },
  no_asistio: { activoMs: 30 * DIA, bloqueoMs: BLOQUEO_MS, accion: 'anonimizar' },
  asistio: { activoMs: 90 * DIA, bloqueoMs: BLOQUEO_MS, accion: 'anonimizar' },
  contratado: { activoMs: 30 * DIA, bloqueoMs: BLOQUEO_MS, accion: 'anonimizar' },
  entregado: { activoMs: 0, bloqueoMs: BLOQUEO_MS, accion: 'anonimizar' },
};

/** Máximo de días entre la contratación y la entrega del expediente (Política §2). */
export const MAX_ENTREGA_MS = 30 * DIA;

/** Referencia de la etapa `entregado`: la entrega, sin pasar de contratación + 30 días. */
export function referenciaEntrega(contratadoEn: Date | null, entregadoEn: Date): Date {
  if (!contratadoEn) return entregadoEn;
  return new Date(Math.min(entregadoEn.getTime(), contratadoEn.getTime() + MAX_ENTREGA_MS));
}

export interface Plazos {
  finActivo: Date;
  finBloqueo: Date;
  accion: Accion;
}

/** `referencia`: fecha de la cita (etapas con cita), de la verificación o de la postulación. */
export function calcularPlazos(etapa: Etapa, referencia: Date): Plazos {
  const p = PLAZOS_POLITICA[etapa];
  const finActivo = new Date(referencia.getTime() + p.activoMs);
  return { finActivo, finBloqueo: new Date(finActivo.getTime() + p.bloqueoMs), accion: p.accion };
}

export type EstadoDatos = 'activo' | 'bloqueado' | 'vencido';

export function estadoEn(p: Plazos, ahora: Date): EstadoDatos {
  const t = ahora.getTime();
  if (t < p.finActivo.getTime()) return 'activo';
  return t < p.finBloqueo.getTime() ? 'bloqueado' : 'vencido';
}

export type EventoCiclo =
  | { tipo: 'LeadCreado' }
  | { tipo: 'WhatsAppVerificado' }
  | { tipo: 'CitaConfirmada' }
  | { tipo: 'CitaReprogramada' }
  | { tipo: 'CitaCancelada'; motivo: string }
  | { tipo: 'AsistenciaRegistrada'; asistio: boolean }
  | { tipo: 'LeadContratado'; entregado: boolean };

const RANGO: Record<Etapa, number> = { sin_verificar: 0, verificado: 1, cita_confirmada: 2, cita_cancelada: 2, no_asistio: 3, asistio: 3, contratado: 4, entregado: 5 };

/** Etapa siguiente. Nunca retrocede de una etapa con cita a una sin cita. */
export function etapaTrasEvento(actual: Etapa | null, ev: EventoCiclo): Etapa {
  const sube = (nueva: Etapa): Etapa => (actual !== null && RANGO[actual] > RANGO[nueva] ? actual : nueva);
  switch (ev.tipo) {
    case 'LeadCreado':
      return actual ?? 'sin_verificar';
    case 'WhatsAppVerificado':
      return sube('verificado');
    case 'CitaConfirmada':
    case 'CitaReprogramada':
      return 'cita_confirmada';
    case 'CitaCancelada':
      if (ev.motivo === 'supresion') return actual ?? 'cita_cancelada';
      return 'cita_cancelada';
    case 'AsistenciaRegistrada':
      return ev.asistio ? 'asistio' : 'no_asistio';
    case 'LeadContratado':
      return sube(ev.entregado ? 'entregado' : 'contratado');
  }
}
