import { z } from 'zod';
import { err, ok, type Result } from '@shared/result.ts';
import { CANALES, TIPOS_MENSAJE, type TipoMensaje } from './tipos.ts';

export const VARIABLES_PERMITIDAS = ['folio', 'nombre', 'fecha', 'hora', 'link_cancelar', 'link_reprogramar', 'codigo'] as const;
export type VariablePlantilla = (typeof VARIABLES_PERMITIDAS)[number];
export type VariablesRender = Partial<Record<VariablePlantilla, string>>;

const RE_VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

const variablesDe = (texto: string): string[] => Array.from(texto.matchAll(RE_VARIABLE), (m) => m[1]!);

/** Reemplaza {{variable}} en una sola pasada (los valores no se re-interpretan). */
export function renderPlantilla(texto: string, vars: VariablesRender): Result<string, string> {
  for (const v of variablesDe(texto)) {
    if (!(VARIABLES_PERMITIDAS as readonly string[]).includes(v)) return err(`VARIABLE_DESCONOCIDA:${v}`);
    if (vars[v as VariablePlantilla] === undefined) return err(`VARIABLE_FALTANTE:${v}`);
  }
  return ok(texto.replace(RE_VARIABLE, (_m, v: string) => vars[v as VariablePlantilla]!));
}

const PlantillaSchema = z.object({
  texto: z
    .string()
    .min(1)
    .max(1000)
    .refine((t) => variablesDe(t).every((v) => (VARIABLES_PERMITIDAS as readonly string[]).includes(v)), {
      message: `variables permitidas: ${VARIABLES_PERMITIDAS.join(', ')}`,
    }),
  asunto: z.string().min(1).max(150).optional(),
});
export type Plantilla = z.infer<typeof PlantillaSchema>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zonaValida = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const VentanaContactoSchema = z
  .object({
    zona_horaria: z.string().refine(zonaValida, 'zona horaria inválida').default('America/Mexico_City'),
    inicio: HHMM.default('08:00'),
    fin: HHMM.default('21:00'),
    /** 0 = domingo … 6 = sábado */
    dias: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]),
  })
  .refine((v) => v.inicio < v.fin, { message: 'inicio debe ser menor que fin', path: ['fin'] });
export type VentanaContacto = z.infer<typeof VentanaContactoSchema>;

const RecordatorioSchema = z.object({ activo: z.boolean(), horas_antes: z.number().min(1).max(72) });

/** Bloque `mensajes` de las reglas por vacante (config.vacantes_reglas.reglas.mensajes). */
export const ReglasMensajesSchema = z.object({
  /** Canal de confirmación, recordatorios y avisos (el OTP usa el que elige el candidato). Sin correo del lead → WhatsApp. */
  canal_preferido: z.enum(CANALES).default('email'),
  plantillas: z.partialRecord(z.enum(TIPOS_MENSAJE), PlantillaSchema).default({}),
  recordatorios: z
    .object({
      h24: RecordatorioSchema.default({ activo: true, horas_antes: 24 }),
      h2: RecordatorioSchema.default({ activo: true, horas_antes: 2 }),
    })
    .prefault({}),
  ventana_contacto: VentanaContactoSchema.prefault({}),
});
export type ReglasMensajes = z.infer<typeof ReglasMensajesSchema>;

export const PLANTILLAS_DEFECTO: Record<TipoMensaje, Plantilla> = {
  otp: { texto: 'Tu código de verificación de 369 Capital Humano es {{codigo}}. Vence en 10 minutos. No lo compartas.', asunto: 'Tu código de verificación' },
  confirmacion: {
    texto: 'Hola {{nombre}}, tu entrevista quedó confirmada para el {{fecha}} a las {{hora}}. Folio: {{folio}}. Para cancelar: {{link_cancelar}} · Para reprogramar: {{link_reprogramar}}',
    asunto: 'Entrevista confirmada · folio {{folio}}',
  },
  recordatorio_24h: {
    texto: 'Hola {{nombre}}, te recordamos tu entrevista mañana {{fecha}} a las {{hora}} (folio {{folio}}). Si no puedes asistir: {{link_reprogramar}}',
    asunto: 'Recordatorio de tu entrevista',
  },
  recordatorio_2h: {
    texto: 'Hola {{nombre}}, tu entrevista es hoy a las {{hora}} (folio {{folio}}). ¡Te esperamos! Si no puedes asistir: {{link_cancelar}}',
    asunto: 'Tu entrevista es hoy',
  },
  cancelacion: { texto: 'Hola {{nombre}}, tu entrevista con folio {{folio}} fue cancelada.', asunto: 'Entrevista cancelada' },
  reprogramacion: {
    texto: 'Hola {{nombre}}, tu entrevista (folio {{folio}}) quedó reprogramada para el {{fecha}} a las {{hora}}. Para cancelar: {{link_cancelar}}',
    asunto: 'Entrevista reprogramada',
  },
  agradecimiento: { texto: 'Gracias por asistir a tu entrevista, {{nombre}}. Pronto te daremos noticias (folio {{folio}}).', asunto: 'Gracias por asistir' },
};

export const plantillaPara = (reglas: ReglasMensajes, tipo: TipoMensaje): Plantilla => reglas.plantillas[tipo] ?? PLANTILLAS_DEFECTO[tipo];
