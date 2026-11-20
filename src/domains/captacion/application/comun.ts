/** Utilidades compartidas por los casos de uso de captación. */
import { hmacSha256Hex } from '../../../shared/crypto.ts';
import { randomBytes } from '../../../shared/ids.ts';
import type { SqlClient } from '../../../shared/sql.ts';
import { CANALES_OTP, expiracionOtp, generarCodigoOtp, hashCodigoOtp, type CanalOtp } from '../domain/otp.ts';
import type { CaptacionRepo, Contexto, DepsCaptacion } from './puertos.ts';

/** HMAC del teléfono E.164 (sin '+') con HMAC_PEPPER: llave de deduplicación y de opt-out. */
export const hmacTelefono = (pepper: string, telefonoE164: string) => hmacSha256Hex(pepper, telefonoE164);
export const hmacIp = (pepper: string, ip: string | null) => (ip ? hmacSha256Hex(pepper, `ip:${ip}`) : Promise.resolve(null));

export const UNA_HORA_MS = 3_600_000;

export const canalHabilitado = (deps: DepsCaptacion, canal: CanalOtp) => (deps.canalesOtp ?? CANALES_OTP).includes(canal);

/** Señal interna para revertir la transacción devolviendo un error de negocio. */
export class Revertir<E> extends Error {
  constructor(readonly error: E) {
    super('revertir');
  }
}

export async function enTransaccion<T, E>(deps: DepsCaptacion, fn: (repo: CaptacionRepo, tx: SqlClient) => Promise<T>): Promise<T | { ok: false; error: E }> {
  try {
    return await deps.sql.transaction((tx) => fn(deps.repo(tx), tx));
  } catch (e) {
    if (e instanceof Revertir) return { ok: false, error: e.error as E };
    throw e;
  }
}

/**
 * Genera un OTP nuevo para el lead (reemplaza el vigente), guarda solo su hash, registra el envío
 * para el rate limit y lo encola cifrado con prioridad alta. Corre dentro de la transacción del llamador.
 */
export async function emitirOtp(
  deps: DepsCaptacion,
  repo: CaptacionRepo,
  tx: SqlClient,
  l: { leadId: string; clienteId: string; vacanteId: string; folio: string; telefonoHmac: string; canal: CanalOtp },
  ctx: Contexto,
  ipHmac: string | null,
): Promise<{ expiraEn: Date }> {
  const ahora = deps.clock.now();
  const otpId = globalThis.crypto.randomUUID();
  const codigo = generarCodigoOtp(deps.random ?? randomBytes);
  const expiraEn = expiracionOtp(ahora);
  await repo.cerrarOtpVigente(l.leadId, 'reemplazado', ahora);
  await repo.insertarOtp({ id: otpId, clienteId: l.clienteId, leadId: l.leadId, codigoHash: await hashCodigoOtp(deps.hmacPepper, otpId, codigo), expiraEn, ahora });
  await repo.registrarEnvio({ tipo: 'otp', clienteId: l.clienteId, telefonoHmac: l.telefonoHmac, ipHmac, leadId: l.leadId, ahora });
  await deps.mensajeria.encolar(tx, {
    tipo: 'otp',
    canal: l.canal,
    leadId: l.leadId,
    vacanteId: l.vacanteId,
    clienteId: l.clienteId,
    llave: `otp:${otpId}`,
    // Sin variables: la cola no lleva PII ni folio; el worker resuelve destino y folio con obtenerContactoLead.
    codigoCifrado: await deps.cifrarCodigo(codigo),
  });
  deps.logger.info('otp_encolado', { lead_id: l.leadId, canal: l.canal, correlation_id: ctx.correlationId });
  return { expiraEn };
}
