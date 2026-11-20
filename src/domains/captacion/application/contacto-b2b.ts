/** Caso de uso del formulario B2B de la portada (CAP-09): formato, anti-bot, consentimiento y 10/h por IP. */
import { err, ok, type Result } from '../../../shared/result.ts';
import { validarContactoB2B } from '../domain/b2b.ts';
import type { ErrorFormulario } from '../domain/formulario.ts';
import { OTP } from '../domain/otp.ts';
import { UNA_HORA_MS, hmacIp } from './comun.ts';
import type { Contexto, DepsCaptacion } from './puertos.ts';

export const CLIENTE_369 = '00000000-0000-0000-0000-000000000369';

export type ErrorB2B = ErrorFormulario | { codigo: 'ANTIBOT_INVALIDO' | 'ANTIBOT_NO_DISPONIBLE' | 'LIMITE_IP' };

export async function registrarContactoB2B(deps: DepsCaptacion, entrada: unknown, ctx: Contexto): Promise<Result<{ recibido: true }, ErrorB2B>> {
  const log = deps.logger.child({ caso: 'contacto_b2b', correlation_id: ctx.correlationId });
  const v = validarContactoB2B(entrada);
  if (!v.ok) return v;
  try {
    if (!(await deps.antiBot.verificar(v.value.turnstileToken, ctx.ip))) return err({ codigo: 'ANTIBOT_INVALIDO' });
  } catch (e) {
    log.warn('antibot_no_disponible', { error: String(e) });
    return err({ codigo: 'ANTIBOT_NO_DISPONIBLE' });
  }
  const ahora = deps.clock.now();
  const ipHmac = await hmacIp(deps.hmacPepper, ctx.ip);
  const repo = deps.repo(deps.sql);
  if (ipHmac) {
    const { porIp } = await repo.contarEnvios('b2b', { telefonoHmac: null, ipHmac, desde: new Date(ahora.getTime() - UNA_HORA_MS) });
    if (porIp >= OTP.MAX_ENVIOS_IP_HORA) return err({ codigo: 'LIMITE_IP' });
  }
  await deps.sql.transaction(async (tx) => {
    const r = deps.repo(tx);
    await r.insertarContactoB2B({ ...v.value, ahora });
    await r.registrarEnvio({ tipo: 'b2b', clienteId: CLIENTE_369, telefonoHmac: null, ipHmac, leadId: null, ahora });
  });
  log.info('contacto_b2b_recibido', { servicio: v.value.servicio });
  return ok({ recibido: true });
}
