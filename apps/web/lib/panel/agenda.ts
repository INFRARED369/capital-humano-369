/** Agenda del día y asistencia (DSH-05, CIT-10, T6). Puro. */
import { z } from 'zod';
import type { Clock } from '../../../../src/shared/clock';
import { err, ok, type Result } from '../../../../src/shared/result';

export interface FilaCita {
  id: string;
  vacante_id: string;
  inicio: string;
  fin: string;
  estado: string;
  asistio: boolean | null;
  evaluacion: Record<string, unknown> | null;
  lead_id: string | null;
}
export interface FilaLead { id: string; folio: string | null; nombre_pila: string | null }

export const ETIQUETA_ESTADO: Record<string, string> = {
  retenida: 'Retenida (sin verificar)',
  confirmada: 'Confirmada',
  asistio: 'Asistió',
  no_asistio: 'No asistió',
  cancelada: 'Cancelada',
  reprogramada: 'Reprogramada',
  expirada: 'Expirada',
};

export interface ItemAgenda extends FilaCita { hora: string; folio: string; nombrePila: string; etiquetaEstado: string }

export function formatearHora(iso: string, zona: string): string {
  return new Intl.DateTimeFormat('es-MX', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function formatearFecha(iso: string, zona: string): string {
  return new Intl.DateTimeFormat('es-MX', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}

export function hoyLocal(clock: Clock, zona: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(clock.now()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function combinarAgenda(citas: readonly FilaCita[], leads: readonly FilaLead[], zona: string): ItemAgenda[] {
  const porId = new Map(leads.map((l) => [l.id, l]));
  return [...citas]
    .sort((a, b) => a.inicio.localeCompare(b.inicio))
    .map((c) => {
      const l = c.lead_id ? porId.get(c.lead_id) : undefined;
      return { ...c, hora: formatearHora(c.inicio, zona), folio: l?.folio ?? '—', nombrePila: l?.nombre_pila ?? 'Candidato', etiquetaEstado: ETIQUETA_ESTADO[c.estado] ?? c.estado };
    });
}

/** confirmada → asistió/no asistió; en asistió/no asistió solo se actualiza la evaluación (mismo valor). */
export const puedeRegistrarAsistencia = (estado: string) => estado === 'confirmada' || estado === 'asistio' || estado === 'no_asistio';

export const RECOMENDACIONES = [
  ['avanzar', 'Avanzar en el proceso'],
  ['en_reserva', 'En reserva'],
  ['descartar', 'Descartar'],
] as const;

export const EvaluacionSchema = z.strictObject({
  calificacion: z.number().int().min(1).max(5).optional(),
  recomendacion: z.enum(['avanzar', 'en_reserva', 'descartar']).optional(),
  notas: z.string().max(1000).optional(),
});
export type Evaluacion = z.output<typeof EvaluacionSchema>;

export function evaluacionDesdeFormulario(d: { calificacion: string; recomendacion: string; notas: string }): Result<Evaluacion | null, string> {
  const crudo: Record<string, unknown> = {};
  if (d.calificacion.trim()) crudo.calificacion = Number(d.calificacion);
  if (d.recomendacion.trim()) crudo.recomendacion = d.recomendacion.trim();
  if (d.notas.trim()) crudo.notas = d.notas.trim();
  if (Object.keys(crudo).length === 0) return ok(null);
  const r = EvaluacionSchema.safeParse(crudo);
  return r.success === true ? ok(r.data) : err('Revisa la evaluación: calificación de 1 a 5 y notas de hasta 1000 caracteres.');
}

export function mensajeErrorAsistencia(mensaje: string): string {
  if (/PERMISO_DENEGADO|permission denied/i.test(mensaje)) return 'No tienes permiso para registrar asistencia en esta vacante.';
  if (/TRANSICION_INVALIDA/.test(mensaje)) return 'La cita ya no está en un estado que permita este registro.';
  if (/NO_ENCONTRADA/.test(mensaje)) return 'La cita no existe o no tienes acceso.';
  if (/EVALUACION_INVALIDA/.test(mensaje)) return 'La evaluación no es válida.';
  return 'No se pudo registrar. Intenta de nuevo.';
}
