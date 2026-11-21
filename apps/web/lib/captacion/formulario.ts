/**
 * Construye y valida en el navegador el cuerpo de `postular` con el MISMO esquema Zod del servidor.
 * El validador (zod + esquemas, ~33 KB gzip) se carga bajo demanda: fuera del bundle inicial de la landing (LCP).
 */
import { uuidv7 } from '../../../../src/shared/ids';
import { err, ok, type Result } from '../../../../src/shared/result';
import type { Pregunta } from '../../../../src/domains/captacion';

let validador: Promise<typeof import('../../../../src/domains/captacion')['validarPostulacion']> | null = null;

/** Carga (una sola vez) el validador; llamarlo al primer contacto con el formulario evita la espera al enviar. */
export function precargarValidador() {
  validador ??= import('../../../../src/domains/captacion').then((m) => m.validarPostulacion);
  return validador;
}

export interface ValoresFormulario {
  nombre: string;
  telefono: string;
  email: string;
  respuestas: Record<string, string>;
}

export type ErroresCampo = Record<string, string>;

export function erroresPorCampo(campos: Array<{ campo: string; mensaje: string }>): ErroresCampo {
  return Object.fromEntries(campos.map((c) => [c.campo, c.mensaje]));
}

export async function construirPostulacion(i: {
  slug: string; preguntas: Pregunta[]; valores: ValoresFormulario; slotInicio: string; versionAviso: string; consentido: boolean;
  turnstileToken: string; atribucion: Record<string, unknown>; canalOtp?: 'whatsapp' | 'sms' | 'email';
}): Promise<Result<Record<string, unknown> & { event_id: string }, ErroresCampo>> {
  const atribucion = Object.fromEntries(Object.entries(i.atribucion).filter(([, v]) => typeof v === 'string' && v !== ''));
  const respuestas = Object.fromEntries(Object.entries(i.valores.respuestas).filter(([, v]) => v !== ''));
  const cuerpo = {
    vacante: i.slug,
    nombre: i.valores.nombre,
    telefono: i.valores.telefono,
    ...(i.valores.email.trim() ? { email: i.valores.email.trim() } : {}),
    respuestas,
    slot_inicio: i.slotInicio,
    consentimiento: { aceptado: i.consentido, version: i.versionAviso },
    turnstile_token: i.turnstileToken,
    event_id: uuidv7(),
    ...(Object.keys(atribucion).length ? { atribucion } : {}),
    ...(i.canalOtp ? { canal_otp: i.canalOtp } : {}),
  };
  const validarPostulacion = await precargarValidador();
  const v = validarPostulacion(cuerpo, i.preguntas);
  if ('error' in v) return err(erroresPorCampo(v.error.campos.map((c) => ({ campo: c.campo.split('.')[0] === 'consentimiento' ? 'consentimiento' : c.campo, mensaje: c.mensaje }))));
  return ok(cuerpo);
}
