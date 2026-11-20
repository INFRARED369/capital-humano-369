/**
 * webhook-nbx (NFR-SEG-05, M5) — PENDIENTE Q-1: formato genérico { id|message_id, status } hasta tener la documentación de NBX.
 * Firma: x-369-signature (sha256=HMAC(NBX_WEBHOOK_SECRET, `${ts}.${cuerpo}`)) y x-369-timestamp. verify_jwt = false.
 */
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerWebhook } from '@domains/comunicacion/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'NBX_WEBHOOK_SECRET']);

Deno.serve(crearHandlerWebhook('nbx', {
  sql: sqlDeno(env.SUPABASE_DB_URL),
  clock: systemClock,
  secreto: env.NBX_WEBHOOK_SECRET,
  pepper: env.HMAC_PEPPER,
  logger: crearLogger({ funcion: 'webhook-nbx' }),
}));
