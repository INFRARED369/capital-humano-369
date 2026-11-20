/**
 * webhook-evolution (NFR-SEG-05, M5, COM-05): estados de entrega y bajas ("BAJA") de WhatsApp.
 * Evolution API v2 no firma con HMAC: se autentica con la cabecera `x-369-webhook-token`
 * (= EVOLUTION_WEBHOOK_SECRET) configurada en `webhook.headers` de la instancia
 * (runbook §10), más frescura del `date_time` (±5 min) y anti-replay por id de evento.
 * Sigue aceptando la firma HMAC (`x-369-signature` + `x-369-timestamp`) si hay un relay que firme.
 * EVOLUTION_WEBHOOK_TZ_OFFSET_MIN (opcional): desfase UTC con el que Evolution escribe `date_time`
 * (0 si su contenedor corre con TZ=UTC, lo recomendado; CDMX = -360).
 * Desplegar con verify_jwt = false (lo llama Evolution, no un usuario).
 */
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerWebhook } from '@domains/comunicacion/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'EVOLUTION_WEBHOOK_SECRET']);
const desfase = Number.parseInt(Deno.env.get('EVOLUTION_WEBHOOK_TZ_OFFSET_MIN') ?? '0', 10);

Deno.serve(crearHandlerWebhook('evolution', {
  sql: sqlDeno(env.SUPABASE_DB_URL),
  clock: systemClock,
  secreto: env.EVOLUTION_WEBHOOK_SECRET,
  pepper: env.HMAC_PEPPER,
  logger: crearLogger({ funcion: 'webhook-evolution' }),
  aceptarToken: true,
  desfaseMin: Number.isFinite(desfase) && Math.abs(desfase) <= 840 ? desfase : 0,
}));
