/** Edge function `contacto-b2b` (CAP-09): formulario de la portada. Solo cableado Deno. */
import { entornoDeno, servir, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerContactoB2B } from '@domains/captacion/infra/http/handlers.ts';
import { crearRepoSql } from '@domains/captacion/infra/sql/repo.ts';
import { crearTurnstileAdapter } from '@domains/captacion/infra/adapters/turnstile.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'TURNSTILE_SECRET', 'ALLOWED_ORIGIN']);
const sinUso = async (): Promise<never> => { throw new Error('no se usa en contacto-b2b'); };

const handler = crearHandlerContactoB2B(
  {
    sql: sqlDeno(env.SUPABASE_DB_URL),
    repo: crearRepoSql,
    agenda: { retener: sinUso, confirmar: sinUso, liberar: sinUso, extender: sinUso },
    mensajeria: { encolar: sinUso },
    whatsapp: { existeEnWhatsApp: sinUso },
    antiBot: crearTurnstileAdapter({ secret: env.TURNSTILE_SECRET, url: Deno.env.get('TURNSTILE_URL') || undefined }),
    formularios: { preguntas: () => null },
    cifrarCodigo: sinUso,
    hmacPepper: env.HMAC_PEPPER,
    clock: systemClock,
    logger: crearLogger({ funcion: 'contacto-b2b' }),
  },
  { origenPermitido: env.ALLOWED_ORIGIN },
);

Deno.serve(servir((req) => handler(req), { funcion: 'contacto-b2b', origenes: env.ALLOWED_ORIGIN }));
