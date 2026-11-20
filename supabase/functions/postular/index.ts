/**
 * Edge function `postular` (CAP-05..CAP-08, P1–P7). Solo cableado Deno: la lógica vive en
 * src/domains/captacion (handler puro probado en Node). Excluido del typecheck de Node.
 * Las preguntas del formulario salen del contenido JSON de cada vacante (mismo archivo que usa la landing),
 * vía el índice GENERADO `../_generated/vacantes.ts` (NFR-ESC-06: `npm run generar:vacantes`, corre en prebuild).
 */
import { entornoDeno, servir, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerPostular } from '@domains/captacion/infra/http/handlers.ts';
import { crearRepoSql } from '@domains/captacion/infra/sql/repo.ts';
import { crearTurnstileAdapter } from '@domains/captacion/infra/adapters/turnstile.ts';
import { CANALES_OTP, ContenidoVacanteSchema, type CanalOtp, type Pregunta } from '@domains/captacion/index.ts';
import { crearAgendaPort } from '@domains/citas/index.ts';
import { cifrarCodigoOtp, crearEvolutionAdapter, encolarMensaje } from '@domains/comunicacion/index.ts';
import { CONTENIDOS_VACANTES } from '../_generated/vacantes.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'OTP_ENC_KEY', 'TURNSTILE_SECRET', 'EVOLUTION_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'ALLOWED_ORIGIN']);

const PREGUNTAS: Record<string, Pregunta[]> = Object.fromEntries(
  CONTENIDOS_VACANTES.map((c) => ContenidoVacanteSchema.parse(c)).map((c) => [c.slug, c.formulario.preguntas]),
);

const sql = sqlDeno(env.SUPABASE_DB_URL);
const evolution = crearEvolutionAdapter({ url: env.EVOLUTION_URL, apiKey: env.EVOLUTION_API_KEY, instancia: env.EVOLUTION_INSTANCE }, fetch);

// CANALES_OTP (opcional, p. ej. "whatsapp,email"): canales de código habilitados; por defecto todos.
const canalesOtp = (Deno.env.get('CANALES_OTP') ?? '').split(',').map((c) => c.trim()).filter((c): c is CanalOtp => (CANALES_OTP as readonly string[]).includes(c));

const handler = crearHandlerPostular(
  {
    sql,
    repo: crearRepoSql,
    agenda: crearAgendaPort(systemClock),
    mensajeria: { encolar: encolarMensaje },
    whatsapp: evolution,
    antiBot: crearTurnstileAdapter({ secret: env.TURNSTILE_SECRET, url: Deno.env.get('TURNSTILE_URL') || undefined }),
    formularios: { preguntas: (slug) => PREGUNTAS[slug] ?? null },
    cifrarCodigo: (codigo) => cifrarCodigoOtp(codigo, env.OTP_ENC_KEY),
    hmacPepper: env.HMAC_PEPPER,
    canalesOtp: canalesOtp.length ? canalesOtp : undefined,
    clock: systemClock,
    logger: crearLogger({ funcion: 'postular' }),
  },
  { origenPermitido: env.ALLOWED_ORIGIN },
);

Deno.serve(servir((req) => handler(req), { funcion: 'postular', origenes: env.ALLOWED_ORIGIN }));
