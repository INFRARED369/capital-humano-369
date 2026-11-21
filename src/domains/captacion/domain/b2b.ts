/** Formulario B2B de la portada (#lead-form, CAP-09): solo formato, consentimiento y anti-bot. */
import { z } from 'zod';
import { err, ok, type Result } from '../../../shared/result.ts';
import { ConsentimientoSchema, erroresDeZod, type ErrorFormulario } from './formulario.ts';
import { SERVICIOS_B2B } from './servicios-b2b.ts';

export { SERVICIOS_B2B };

export const ContactoB2BSchema = z.strictObject({
  nombre: z.string().trim().min(2).max(120),
  empresa: z.string().trim().min(1).max(160),
  email: z.email().max(254),
  servicio: z.enum(SERVICIOS_B2B),
  mensaje: z.string().trim().max(2000).optional(),
  consentimiento: ConsentimientoSchema,
  turnstile_token: z.string().min(1).max(2048),
});

export interface ContactoB2BValido {
  nombre: string;
  empresa: string;
  email: string;
  servicio: (typeof SERVICIOS_B2B)[number];
  mensaje: string | null;
  consentimientoVersion: string;
  turnstileToken: string;
}

export function validarContactoB2B(entrada: unknown): Result<ContactoB2BValido, ErrorFormulario> {
  const r = ContactoB2BSchema.safeParse(entrada);
  if (!r.success) return err(erroresDeZod(r.error.issues));
  const d = r.data;
  return ok({ nombre: d.nombre, empresa: d.empresa, email: d.email.toLowerCase(), servicio: d.servicio, mensaje: d.mensaje || null, consentimientoVersion: d.consentimiento.version, turnstileToken: d.turnstile_token });
}
