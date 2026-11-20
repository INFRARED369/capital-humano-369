/**
 * Casos de uso `verificarOtp` y `reenviarOtp` (O1–O5, D11).
 * - Correcto dentro del TTL → confirma la cita (AgendaPort) y publica WhatsAppVerificado (CitaConfirmada la publica citas).
 * - 5 errores → OTP bloqueado, lead `otp_bloqueado` y retención liberada.
 * - Vencido → error con opción de reenviar si queda cupo (3 códigos por teléfono por hora, 10 por IP).
 * - Un reenvío puede cambiar de canal (WhatsApp ↔ SMS ↔ correo); por correo puede traer el email a usar.
 * - Un reenvío genera un código nuevo e invalida el anterior y extiende la retención del slot
 *   (AgendaPort.extender, con el tope de citas). Si la retención ya venció → RETENCION_EXPIRADA, sin código.
 */
import { z } from 'zod';
import { uuidv7 } from '../../../shared/ids.ts';
import { err, ok, type Result } from '../../../shared/result.ts';
import { erroresDeZod, type ErrorFormulario } from '../domain/formulario.ts';
import { CANALES_OTP, evaluarIntento, evaluarLimiteEnvio, hashCodigoOtp, type CanalOtp } from '../domain/otp.ts';
import { Revertir, UNA_HORA_MS, canalHabilitado, emitirOtp, enTransaccion, hmacIp } from './comun.ts';
import type { CaptacionRepo, Contexto, DepsCaptacion, LeadParaVerificar } from './puertos.ts';

const VerificarSchema = z.strictObject({ lead_id: z.uuid(), codigo: z.string().regex(/^\d{6}$/) });
const ReenviarSchema = z.strictObject({
  lead_id: z.uuid(),
  canal: z.enum(CANALES_OTP).default('whatsapp'),
  email: z.email().max(254).optional(),
});

export interface VerificacionOk {
  folio: string;
  nombrePila: string;
  cita: { id: string; inicio: string; fin: string };
}
export interface ReenvioOk {
  expiraEn: string;
  reenviosRestantes: number;
  canal: CanalOtp;
  /** Nueva expiración de la retención del slot (null si el lead no tiene cita retenida). */
  retencionExpiraEn: string | null;
}

export type ErrorVerificar =
  | ErrorFormulario
  | { codigo: 'NO_ENCONTRADO' | 'OTP_BLOQUEADO' | 'RETENCION_EXPIRADA' | 'LIMITE_TELEFONO' | 'LIMITE_IP' | 'CANAL_NO_DISPONIBLE' | 'EMAIL_REQUERIDO' }
  | { codigo: 'OTP_INCORRECTO'; intentosRestantes: number }
  | { codigo: 'OTP_VENCIDO'; puedeReenviar: boolean }
  | { codigo: 'YA_VERIFICADO'; folio: string };

async function cupoEnvio(repo: CaptacionRepo, deps: DepsCaptacion, lead: LeadParaVerificar, ipHmac: string | null) {
  const desde = new Date(deps.clock.now().getTime() - UNA_HORA_MS);
  return evaluarLimiteEnvio(await repo.contarEnvios('otp', { telefonoHmac: lead.telefonoHmac, ipHmac, desde }));
}

export async function verificarOtp(deps: DepsCaptacion, entrada: unknown, ctx: Contexto): Promise<Result<VerificacionOk, ErrorVerificar>> {
  const v = VerificarSchema.safeParse(entrada);
  if (!v.success) return err(erroresDeZod(v.error.issues));
  const { lead_id: leadId, codigo } = v.data;
  const log = deps.logger.child({ caso: 'verificar_otp', correlation_id: ctx.correlationId, lead_id: leadId });
  const ipHmac = await hmacIp(deps.hmacPepper, ctx.ip);

  const r = await enTransaccion<Result<VerificacionOk, ErrorVerificar>, ErrorVerificar>(deps, async (repo, tx) => {
    const ahora = deps.clock.now();
    const lead = await repo.obtenerLead(leadId);
    if (!lead) return err({ codigo: 'NO_ENCONTRADO' });
    if (lead.estado === 'verificado') return err({ codigo: 'YA_VERIFICADO', folio: lead.folio });
    const otp = await repo.ultimoOtp(leadId);
    if (!otp) return err({ codigo: 'NO_ENCONTRADO' });

    const intento = evaluarIntento(otp, await hashCodigoOtp(deps.hmacPepper, otp.id, codigo), ahora);
    switch (intento.resultado) {
      case 'INCORRECTO':
        await repo.actualizarOtp(otp.id, { intentos: intento.intentos, estado: 'vigente', ahora });
        return err({ codigo: 'OTP_INCORRECTO', intentosRestantes: intento.restantes });
      case 'BLOQUEADO':
        if (otp.estado !== 'bloqueado') {
          await repo.actualizarOtp(otp.id, { intentos: intento.intentos, estado: 'bloqueado', ahora });
          await repo.marcarLead(leadId, 'otp_bloqueado', ahora);
          if (lead.citaId) await deps.agenda.liberar(tx, { citaId: lead.citaId, motivo: 'OTP_BLOQUEADO' });
          await repo.asignarCita(leadId, null, null, ahora);
          log.warn('otp_bloqueado');
        }
        return err({ codigo: 'OTP_BLOQUEADO' });
      case 'VENCIDO':
      case 'NO_VIGENTE':
        if (otp.estado === 'vigente') await repo.actualizarOtp(otp.id, { intentos: otp.intentos, estado: 'vencido', ahora });
        return err({ codigo: 'OTP_VENCIDO', puedeReenviar: (await cupoEnvio(repo, deps, lead, ipHmac)).ok });
      case 'YA_VERIFICADO':
        return err({ codigo: 'YA_VERIFICADO', folio: lead.folio });
      case 'CORRECTO':
        break;
    }

    await repo.actualizarOtp(otp.id, { intentos: otp.intentos, estado: 'verificado', ahora });
    if (!lead.citaId) return err({ codigo: 'RETENCION_EXPIRADA' });
    const conf = await deps.agenda.confirmar(tx, { citaId: lead.citaId, folio: lead.folio, nombrePila: lead.nombrePila, eventId: uuidv7(ahora) });
    if (!conf.ok) {
      // El WhatsApp quedó probado, pero el horario ya no está: el candidato elige otro y vuelve a postular (P5 reutiliza el lead).
      await repo.asignarCita(leadId, null, null, ahora);
      log.info('retencion_expirada_al_confirmar', { motivo: conf.error });
      return err({ codigo: 'RETENCION_EXPIRADA' });
    }
    await repo.marcarLead(leadId, 'verificado', ahora);
    await repo.publicarEvento('WhatsAppVerificado', { lead_id: leadId, vacante_id: lead.vacanteId, cliente_id: lead.clienteId, event_id: uuidv7(ahora) }, lead.clienteId, ctx.correlationId);
    return ok({ folio: lead.folio, nombrePila: lead.nombrePila, cita: { id: conf.value.citaId, inicio: conf.value.inicio, fin: conf.value.fin } });
  });

  log.info(r.ok ? 'otp_verificado' : 'otp_no_verificado', r.ok ? {} : { motivo: r.error.codigo });
  return r;
}

export async function reenviarOtp(deps: DepsCaptacion, entrada: unknown, ctx: Contexto): Promise<Result<ReenvioOk, ErrorVerificar>> {
  const v = ReenviarSchema.safeParse(entrada);
  if (!v.success) return err(erroresDeZod(v.error.issues));
  const { lead_id: leadId, canal } = v.data;
  const email = v.data.email?.trim().toLowerCase();
  if (!canalHabilitado(deps, canal)) return err({ codigo: 'CANAL_NO_DISPONIBLE' });
  const ipHmac = await hmacIp(deps.hmacPepper, ctx.ip);

  const r = await enTransaccion<Result<ReenvioOk, ErrorVerificar>, ErrorVerificar>(deps, async (repo, tx) => {
    const lead = await repo.obtenerLead(leadId);
    if (!lead) return err({ codigo: 'NO_ENCONTRADO' });
    if (lead.estado === 'verificado') return err({ codigo: 'YA_VERIFICADO', folio: lead.folio });
    if (lead.estado === 'otp_bloqueado') return err({ codigo: 'OTP_BLOQUEADO' });
    if (canal === 'email' && !email && !lead.tieneEmail) return err({ codigo: 'EMAIL_REQUERIDO' });
    await repo.bloquearTelefono(lead.vacanteId, lead.telefonoHmac);
    const cupo = await cupoEnvio(repo, deps, lead, ipHmac);
    if (!cupo.ok) throw new Revertir<ErrorVerificar>({ codigo: cupo.error });
    let retencionExpiraEn: string | null = null;
    if (lead.citaId) {
      const ext = await deps.agenda.extender(tx, { citaId: lead.citaId });
      if (!ext.ok) throw new Revertir<ErrorVerificar>({ codigo: 'RETENCION_EXPIRADA' });
      retencionExpiraEn = ext.value.expiraEn;
    }
    if (canal === 'email' && email) await repo.actualizarEmail(leadId, email, deps.clock.now());
    const otp = await emitirOtp(deps, repo, tx, { leadId, clienteId: lead.clienteId, vacanteId: lead.vacanteId, folio: lead.folio, telefonoHmac: lead.telefonoHmac, canal }, ctx, ipHmac);
    return ok({ expiraEn: otp.expiraEn.toISOString(), reenviosRestantes: cupo.value.restantesTelefono, canal, retencionExpiraEn });
  });
  deps.logger.info(r.ok ? 'otp_reenviado' : 'otp_reenvio_rechazado', { lead_id: leadId, canal, correlation_id: ctx.correlationId, ...(r.ok ? {} : { motivo: r.error.codigo }) });
  return r;
}
