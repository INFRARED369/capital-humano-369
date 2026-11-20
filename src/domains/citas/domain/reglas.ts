/**
 * Reglas de agenda por vacante (§1.1, D1–D3, D7). La plantilla por defecto es la de
 * "Reglas de negocio reservas": L–V, inicios 9:30…13:00 y 15:00…17:00 cada 30 min,
 * 1 persona por slot (2 por hora), 10 por día, 90 min con empalmes permitidos, UTC-6
 * (America/Mexico_City no tiene horario de verano desde 2022, así que es equivalente).
 */
import { z } from 'zod';
import { err, ok, type Result } from '@shared/result.ts';
import { esZonaValida, minutosDeHora } from './tiempo.ts';

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const esFechaReal = (s: string) => {
  if (!FECHA.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const Hora = z.string().regex(HORA, 'Hora HH:MM (24 h)');
const Fecha = z.string().refine(esFechaReal, 'Fecha YYYY-MM-DD válida');

export const VentanaInicioSchema = z
  .strictObject({ desde: Hora, hasta: Hora })
  .refine((v) => minutosDeHora(v.desde) <= minutosDeHora(v.hasta), 'La ventana termina antes de empezar');

export const BloqueoSchema = z
  .strictObject({
    desde: z.iso.datetime({ offset: true }),
    hasta: z.iso.datetime({ offset: true }),
    motivo: z.string().max(120).optional(),
  })
  .refine((b) => Date.parse(b.desde) < Date.parse(b.hasta), 'El bloqueo termina antes de empezar');

/** Valores de la plantilla (fuente única para los defaults del esquema). */
const DEF = {
  zona_horaria: 'America/Mexico_City',
  dias_habiles: [1, 2, 3, 4, 5],
  ventanas_inicio: [
    { desde: '09:30', hasta: '13:00' },
    { desde: '15:00', hasta: '17:00' },
  ],
  intervalo_min: 30,
  capacidad_por_slot: 1,
  duracion_cita_min: 90,
  permitir_empalmes: true,
  cupo_diario: 10,
  antelacion_min_horas: 2,
  horizonte_dias: 14,
  festivos: [] as string[],
  bloqueos: [] as Array<{ desde: string; hasta: string; motivo?: string }>,
  ttl_retencion_min: 10,
} as const;

export const ReglasAgendaSchema = z.strictObject({
  /** Zona IANA de la vacante; los slots se expresan en ella y se guardan en UTC. */
  zona_horaria: z.string().refine(esZonaValida, 'Zona horaria IANA inválida').default(DEF.zona_horaria),
  /** 1 = lunes … 7 = domingo. */
  dias_habiles: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .refine((d) => new Set(d).size === d.length, 'Días repetidos')
    .default(() => [...DEF.dias_habiles]),
  /** Rangos en los que puede INICIAR una cita (inicio y fin incluidos, D1). */
  ventanas_inicio: z.array(VentanaInicioSchema).min(1).max(12).default(() => DEF.ventanas_inicio.map((v) => ({ ...v }))),
  intervalo_min: z.number().int().min(5).max(240).default(DEF.intervalo_min),
  capacidad_por_slot: z.number().int().min(1).max(50).default(DEF.capacidad_por_slot),
  duracion_cita_min: z.number().int().min(5).max(8 * 60).default(DEF.duracion_cita_min),
  /** true: las citas de distintos candidatos pueden traslaparse (solo cuenta el mismo inicio). */
  permitir_empalmes: z.boolean().default(DEF.permitir_empalmes),
  cupo_diario: z.number().int().min(1).max(500).default(DEF.cupo_diario),
  antelacion_min_horas: z.number().min(0).max(24 * 14).default(DEF.antelacion_min_horas),
  /** Días naturales que se ofrecen, contando hoy (zona de la vacante). */
  horizonte_dias: z.number().int().min(1).max(90).default(DEF.horizonte_dias),
  festivos: z.array(Fecha).max(366).default(() => []),
  /** Bloqueos manuales: se excluyen los inicios dentro de [desde, hasta). */
  bloqueos: z.array(BloqueoSchema).max(500).default(() => []),
  /** Minutos que un slot queda retenido esperando el OTP. */
  ttl_retencion_min: z.number().int().min(1).max(120).default(DEF.ttl_retencion_min),
});

export type ReglasAgenda = z.output<typeof ReglasAgendaSchema>;

function congelar<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(congelar);
    Object.freeze(o);
  }
  return o;
}

export const PLANTILLA_AGENDA_DEFECTO: ReglasAgenda = congelar(ReglasAgendaSchema.parse({}));

/** Fila de `config.reglas_vigentes(vacante)`: el JSON compuesto es `{ agenda, mensajes, … }`. */
export interface FilaReglas { version: number; reglas: unknown }

export function extraerReglasAgenda(fila: FilaReglas | null): Result<{ version: number; agenda: ReglasAgenda }, 'REGLAS_INVALIDAS'> {
  if (!fila) return ok({ version: 0, agenda: PLANTILLA_AGENDA_DEFECTO });
  const agenda = (fila.reglas as { agenda?: unknown } | null)?.agenda;
  if (agenda === undefined) return ok({ version: fila.version, agenda: PLANTILLA_AGENDA_DEFECTO });
  const r = ReglasAgendaSchema.safeParse(agenda);
  return r.success ? ok({ version: fila.version, agenda: r.data }) : err('REGLAS_INVALIDAS');
}
