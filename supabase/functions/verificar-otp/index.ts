/**
 * Edge function `verificar-otp` (O1–O5): POST /verificar-otp · POST /verificar-otp/reenviar.
 * Solo cableado Deno; excluido del typecheck de Node.
 */
import { entornoDeno, servir, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerVerificarOtp } from '@domains/captacion/infra/http/handlers.ts';
import { crearRepoSql } from '@domains/captacion/infra/sql/repo.ts';
import { CANALES_OTP, type CanalOtp } from '@domains/captacion/index.ts';
import { crearAgendaPort } from '@domains/citas/index.ts';
import { cifrarCodigoOtp, encolarMensaje } from '@domains/comunicacion/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'OTP_ENC_KEY', 'ALLOWED_ORIGIN']);
const sinUso = async () => { throw new Error('no se usa en verificar-otp'); };

// CANALES_OTP (opcional, p. ej. "whatsapp,email"): canales de código habilitados; por defecto todos.
const canalesOtp = (Deno.env.get('CANALES_OTP') ?? '').split(',').map((c) => c.trim()).filter((c): c is CanalOtp => (CANALES_OTP as readonly string[]).includes(c));

const handler = crearHandlerVerificarOtp(
  {
    sql: sqlDeno(env.SUPABASE_DB_URL),
    repo: crearRepoSql,
    agenda: crearAgendaPort(systemClock),
    mensajeria: { encolar: encolarMensaje },
    whatsapp: { existeEnWhatsApp: sinUso },
    antiBot: { verificar: sinUso },
    formularios: { preguntas: () => null },
    cifrarCodigo: (codigo) => cifrarCodigoOtp(codigo, env.OTP_ENC_KEY),
    hmacPepper: env.HMAC_PEPPER,
    canalesOtp: canalesOtp.length ? canalesOtp : undefined,
    clock: systemClock,
    logger: crearLogger({ funcion: 'verificar-otp' }),
  },
  { origenPermitido: env.ALLOWED_ORIGIN },
);

Deno.serve(servir((req) => handler(req), { funcion: 'verificar-otp', origenes: env.ALLOWED_ORIGIN }));
