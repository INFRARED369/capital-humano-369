/**
 * Reglas operativas por vacante (§1 regla 5, D6, D7, DSH-04). Compone los bloques de cada dominio
 * dueño de la regla —`agenda` (citas) y `mensajes` (comunicacion)— más el calendario de Zoho.
 * La plantilla por defecto es el valor inicial: `ReglasVacanteSchema.parse({})`.
 * Ubicación canónica de la ventana de contacto: `mensajes.ventana_contacto` (comunicación también
 * acepta la raíz, pero aquí la raíz es estricta para que haya una sola fuente).
 */
import { z } from 'zod';
import { ReglasAgendaSchema, normalizarCalendarUid } from '@domains/citas/index.ts';
import { ReglasMensajesSchema } from '@domains/comunicacion/index.ts';
import { err, ok, type Result } from '@shared/result.ts';

/** Tope de tamaño del JSON (igual que la validación mínima de config.guardar_reglas). */
export const MAX_BYTES_REGLAS = 64 * 1024;

const CalendarUid = z
  .string()
  .transform((v, ctx) => {
    const n = normalizarCalendarUid(v);
    if (n === null) {
      ctx.addIssue({ code: 'custom', message: 'UID de calendario de Zoho inválido' });
      return z.NEVER;
    }
    return n;
  });

export const ReglasVacanteSchema = z.strictObject({
  agenda: ReglasAgendaSchema.prefault({}),
  mensajes: ReglasMensajesSchema.prefault({}),
  /** Calendario de Zoho de la vacante (D8). Sin él, la cita se confirma igual y se avisa (Z7). */
  zoho_calendar_uid: CalendarUid.optional(),
});

export type ReglasVacante = z.output<typeof ReglasVacanteSchema>;

function congelar<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(congelar);
    Object.freeze(o);
  }
  return o;
}

export const PLANTILLA_VACANTE_DEFECTO: ReglasVacante = congelar(ReglasVacanteSchema.parse({}));

export interface Problema { ruta: string; mensaje: string }

/** Valida y completa con la plantilla. Los mensajes nunca repiten el valor recibido. */
export function normalizarReglas(entrada: unknown): Result<ReglasVacante, Problema[]> {
  const r = ReglasVacanteSchema.safeParse(entrada);
  if (r.success === false) return err(r.error.issues.map((i) => ({ ruta: i.path.map(String).join('.'), mensaje: i.message })));
  if (new TextEncoder().encode(JSON.stringify(r.data)).length > MAX_BYTES_REGLAS) return err([{ ruta: '', mensaje: 'Las reglas exceden 64 KB' }]);
  return ok(r.data);
}

export type CodigoAdvertencia = 'SIN_CALENDARIO_ZOHO' | 'ZONAS_DISTINTAS' | 'CAPACIDAD_MAYOR_QUE_CUPO' | 'RECORDATORIOS_INVERTIDOS' | 'RETENCION_SIN_ANTELACION';
export interface Advertencia { codigo: CodigoAdvertencia; mensaje: string }

/** Avisos no bloqueantes que el editor muestra antes de guardar. */
export function advertenciasReglas(r: ReglasVacante): Advertencia[] {
  const a: Advertencia[] = [];
  if (!r.zoho_calendar_uid) a.push({ codigo: 'SIN_CALENDARIO_ZOHO', mensaje: 'Sin calendario de Zoho: las citas se confirman, pero el reclutador no las verá en Zoho.' });
  if (r.mensajes.ventana_contacto.zona_horaria !== r.agenda.zona_horaria)
    a.push({ codigo: 'ZONAS_DISTINTAS', mensaje: 'La zona horaria de la ventana de contacto es distinta a la de la agenda.' });
  if (r.agenda.capacidad_por_slot > r.agenda.cupo_diario)
    a.push({ codigo: 'CAPACIDAD_MAYOR_QUE_CUPO', mensaje: 'La capacidad por horario supera el cupo diario; el cupo manda.' });
  const { h24, h2 } = r.mensajes.recordatorios;
  if (h24.activo && h2.activo && h2.horas_antes >= h24.horas_antes)
    a.push({ codigo: 'RECORDATORIOS_INVERTIDOS', mensaje: 'El recordatorio corto sale antes que el largo.' });
  if (r.agenda.antelacion_min_horas * 60 < r.agenda.ttl_retencion_min)
    a.push({ codigo: 'RETENCION_SIN_ANTELACION', mensaje: 'La antelación mínima es menor que la retención del OTP: un horario podría vencer mientras se verifica.' });
  return a;
}
