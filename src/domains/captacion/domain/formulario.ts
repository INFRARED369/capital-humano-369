/**
 * Formulario de postulación por vacante (CAP-03, CAP-04, D4).
 * Las preguntas se definen en el contenido JSON de la vacante (apps/web/vacantes/{slug}.json).
 * Validación SOLO de formato: no existe filtro ni descalificación; cualquier combinación de
 * respuestas válidas en formato produce un lead (P1). Estricto contra campos extra (P4).
 * El mismo esquema se usa en el navegador (validación previa) y en el servidor (autoridad).
 */
import { z } from 'zod';
import { UUID_V7_RE } from '../../../shared/ids.ts';
import { err, ok, type Result } from '../../../shared/result.ts';
import { nombrePila } from './lead.ts';
import { CANALES_OTP, type CanalOtp } from './otp.ts';

const ID_PREGUNTA = /^[a-z][a-z0-9_]{0,39}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const Base = { id: z.string().regex(ID_PREGUNTA), etiqueta: z.string().min(1).max(400), requerida: z.boolean().default(true), ayuda: z.string().max(400).optional() };

export const PreguntaSchema = z.discriminatedUnion('tipo', [
  z.strictObject({ ...Base, tipo: z.literal('texto'), min: z.number().int().min(0).max(500).optional(), max: z.number().int().min(1).max(500).optional(), placeholder: z.string().max(120).optional() }),
  z.strictObject({ ...Base, tipo: z.literal('numero'), min: z.number().optional(), max: z.number().optional(), entero: z.boolean().default(true), placeholder: z.string().max(120).optional() }),
  z.strictObject({
    ...Base,
    tipo: z.literal('opcion'),
    presentacion: z.enum(['select', 'tarjetas']).default('select'),
    opciones: z.array(z.strictObject({ valor: z.string().min(1).max(120), etiqueta: z.string().min(1).max(200) })).min(1).max(50),
  }),
]);
export type Pregunta = z.input<typeof PreguntaSchema>;
export type PreguntaNormalizada = z.output<typeof PreguntaSchema>;

export const PreguntasSchema = z.array(PreguntaSchema).max(30).refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, { message: 'ids de pregunta duplicados' });

const textoLimpio = (max: number, min = 1) => z.string().trim().min(min).max(max);
const opcional = (max: number) => z.string().trim().max(max).optional();

export const AtribucionSchema = z.strictObject({
  visitor_id: opcional(64),
  utm_source: opcional(200), utm_medium: opcional(200), utm_campaign: opcional(200), utm_content: opcional(200), utm_term: opcional(200),
  fbclid: opcional(500), gclid: opcional(500), fbc: opcional(500), fbp: opcional(200), referrer: opcional(500), landing: opcional(500), origen: opcional(40),
});
export type Atribucion = z.output<typeof AtribucionSchema>;

export const ConsentimientoSchema = z.strictObject({ aceptado: z.literal(true), version: z.string().trim().min(1).max(32) });

function esquemaRespuesta(p: PreguntaNormalizada): z.ZodType {
  switch (p.tipo) {
    case 'texto': {
      const s = textoLimpio(p.max ?? 300, p.requerida ? Math.max(1, p.min ?? 1) : 0);
      // texto opcional vacío se omite
      return p.requerida ? s : s.optional().transform((v) => (v ? v : undefined));
    }
    case 'numero': {
      const n = z
        .union([z.number(), z.string().trim().min(1).max(20)])
        .transform((v) => Number(v))
        .refine(Number.isFinite, 'número inválido')
        .refine((v) => !p.entero || Number.isInteger(v), 'debe ser entero')
        .refine((v) => p.min === undefined || v >= p.min, `mínimo ${p.min}`)
        .refine((v) => p.max === undefined || v <= p.max, `máximo ${p.max}`);
      const conTexto = n;
      return p.requerida ? conTexto : conTexto.optional();
    }
    case 'opcion': {
      const e = z.enum(p.opciones.map((o) => o.valor) as [string, ...string[]]);
      return p.requerida ? e : e.optional();
    }
  }
}

/** Esquema Zod estricto del cuerpo de `postular` para las preguntas de una vacante. */
export function construirEsquemaPostulacion(preguntas: Pregunta[]) {
  const ps = PreguntasSchema.parse(preguntas);
  const respuestas = z.strictObject(Object.fromEntries(ps.map((p) => [p.id, esquemaRespuesta(p)])));
  return z.strictObject({
    vacante: z.string().regex(SLUG).max(80),
    nombre: textoLimpio(120, 2).regex(/^[\p{L}\p{M}' .-]+$/u, 'solo letras'),
    telefono: z.string().trim().max(20).transform((v) => v.replace(/[\s()-]/g, '')).pipe(z.string().regex(/^\d{10}$/, 'deben ser 10 dígitos')),
    email: z.union([z.literal(''), z.email().max(254)]).optional(),
    respuestas,
    slot_inicio: z.iso.datetime({ offset: true }),
    consentimiento: ConsentimientoSchema,
    turnstile_token: z.string().min(1).max(2048),
    event_id: z.string().regex(UUID_V7_RE),
    atribucion: AtribucionSchema.optional(),
    /** Canal del código de verificación; por defecto WhatsApp. Correo exige `email`. */
    canal_otp: z.enum(CANALES_OTP).optional(),
  }).refine((d) => d.canal_otp !== 'email' || !!d.email, { path: ['email'], message: 'escribe tu correo para recibir el código' });
}

export interface PostulacionValida {
  vacanteSlug: string;
  nombre: string;
  nombrePila: string;
  telefonoE164: string;
  email: string | null;
  respuestas: Record<string, string | number>;
  slotInicio: string;
  consentimientoVersion: string;
  turnstileToken: string;
  eventId: string;
  atribucion: Atribucion;
  canalOtp: CanalOtp;
}

export type CodigoErrorFormulario = 'FORMATO_INVALIDO' | 'CONSENTIMIENTO_REQUERIDO' | 'ANTIBOT_REQUERIDO';
export interface ErrorFormulario {
  codigo: CodigoErrorFormulario;
  campos: Array<{ campo: string; mensaje: string }>;
}

/** Traduce issues de Zod a errores por campo, sin repetir valores enviados. */
export function erroresDeZod(issues: readonly z.core.$ZodIssue[]): ErrorFormulario {
  const campos = issues.map((i) => ({ campo: i.path.map(String).join('.') || '(cuerpo)', mensaje: mensajeSeguro(i) }));
  const raiz = new Set(campos.map((c) => c.campo.split('.')[0]));
  const codigo: CodigoErrorFormulario = raiz.has('consentimiento') ? 'CONSENTIMIENTO_REQUERIDO' : raiz.has('turnstile_token') ? 'ANTIBOT_REQUERIDO' : 'FORMATO_INVALIDO';
  return { codigo, campos };
}

function mensajeSeguro(i: z.core.$ZodIssue): string {
  switch (i.code) {
    case 'unrecognized_keys': return `campos no permitidos: ${i.keys.join(', ')}`;
    case 'too_big': return 'demasiado largo o grande';
    case 'too_small': return 'obligatorio o demasiado corto';
    case 'invalid_value': return 'opción no válida';
    case 'invalid_type': return 'obligatorio o tipo inválido';
    default: return i.message.slice(0, 120);
  }
}

export function validarPostulacion(entrada: unknown, preguntas: Pregunta[]): Result<PostulacionValida, ErrorFormulario> {
  const r = construirEsquemaPostulacion(preguntas).safeParse(entrada);
  if (!r.success) return err(erroresDeZod(r.error.issues));
  const d = r.data;
  const respuestas = Object.fromEntries(Object.entries(d.respuestas as Record<string, unknown>).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
  const atribucion = Object.fromEntries(Object.entries(d.atribucion ?? {}).filter(([, v]) => v)) as Atribucion;
  return ok({
    vacanteSlug: d.vacante,
    nombre: d.nombre.replace(/\s+/g, ' '),
    nombrePila: nombrePila(d.nombre),
    telefonoE164: `52${d.telefono}`,
    email: d.email ? d.email.toLowerCase() : null,
    respuestas,
    slotInicio: new Date(d.slot_inicio).toISOString(),
    consentimientoVersion: d.consentimiento.version,
    turnstileToken: d.turnstile_token,
    eventId: d.event_id,
    atribucion,
    canalOtp: d.canal_otp ?? 'whatsapp',
  });
}
