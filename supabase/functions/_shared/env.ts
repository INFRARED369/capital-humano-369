/**
 * Lectura validada del entorno de las edge functions (NFR-SEG-02).
 * Cada función pide SOLO las claves que usa; si falta o es inválida alguna, falla al
 * arrancar (no en la primera petición) con un error que lista nombres, nunca valores.
 *
 *   const env = leerEntorno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'ALLOWED_ORIGIN'], Deno.env.toObject());
 */
import { z } from 'zod';

const secreto = (min = 1) => z.string().min(min);
const url = () => z.string().regex(/^https?:\/\/[^\s]+$/, 'URL http(s)');
const origen = z.string().regex(/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i, 'origen sin ruta ni barra final');

/** Divide "a,b" en orígenes válidos. */
export function origenesPermitidos(valor: string): string[] {
  return valor.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Esquema de TODAS las variables de src/CONTRATOS.md (ver también .env.example). */
export const ESQUEMA_ENTORNO = {
  SUPABASE_DB_URL: z.string().regex(/^postgres(?:ql)?:\/\//, 'URL postgres://'),
  SUPABASE_URL: url(),
  HMAC_PEPPER: secreto(32),
  OTP_ENC_KEY: z.string().refine((v) => {
    try {
      return atob(v).length === 32;
    } catch {
      return false;
    }
  }, 'base64 de 32 bytes'),
  LINKS_SECRET: secreto(32),
  TURNSTILE_SECRET: secreto(),
  EVOLUTION_URL: url(),
  EVOLUTION_API_KEY: secreto(),
  EVOLUTION_INSTANCE: secreto(),
  EVOLUTION_WEBHOOK_SECRET: secreto(16),
  SMTP_HOST: secreto(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_USER: secreto(),
  SMTP_PASS: secreto(),
  SMTP_FROM: secreto(),
  NBX_API_URL: url(),
  NBX_API_KEY: secreto(),
  NBX_SENDER: secreto(),
  NBX_WEBHOOK_SECRET: secreto(16),
  ZOHO_CLIENT_ID: secreto(),
  ZOHO_CLIENT_SECRET: secreto(),
  ZOHO_REFRESH_TOKEN: secreto(),
  ZOHO_DC: z.enum(['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'com.cn']),
  META_PIXEL_ID: z.string().regex(/^\d{5,20}$/, 'id numérico'),
  META_CAPI_TOKEN: secreto(),
  STAPE_URL: url(),
  GA4_API_SECRET: secreto(),
  ALLOWED_ORIGIN: z
    .string()
    .transform(origenesPermitidos)
    .pipe(z.array(origen).min(1)),
  PANEL_URL: url(),
} as const;

export type ClaveEntorno = keyof typeof ESQUEMA_ENTORNO;
export type Entorno<K extends ClaveEntorno> = { [P in K]: z.output<(typeof ESQUEMA_ENTORNO)[P]> };

export class ErrorEntorno extends Error {
  constructor(readonly claves: string[], detalle: string) {
    super(`Entorno inválido (${claves.join(', ')}): ${detalle}`);
    this.name = 'ErrorEntorno';
  }
}

export function leerEntorno<K extends ClaveEntorno>(claves: readonly K[], fuente: Record<string, string | undefined>): Entorno<K> {
  const forma = Object.fromEntries(claves.map((k) => [k, ESQUEMA_ENTORNO[k]]));
  // Vacío = faltante.
  const valores = Object.fromEntries(claves.map((k) => [k, fuente[k] === '' ? undefined : fuente[k]]));
  const r = z.object(forma).safeParse(valores);
  if (r.success) return r.data as Entorno<K>;
  const malas = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
  // Solo nombres y el tipo de problema; Zod no incluye el valor recibido en estos mensajes,
  // pero por defensa no se propaga `issue.input`.
  const detalle = r.error.issues.map((i) => `${String(i.path[0])}: ${i.code === 'invalid_type' ? 'falta' : 'formato inválido'}`).join('; ');
  throw new ErrorEntorno(malas, detalle);
}
