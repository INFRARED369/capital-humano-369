/**
 * Caso de uso `postular` (CAP-05..CAP-08, P1–P7, D4, D11).
 * Orden: formato → anti-bot → vacante → rate limit → dedupe "ya postulado" → WhatsApp existe (P7)
 * → UNA transacción: lead + folio + retención del slot + OTP (hash) encolado + outbox LeadCreado (P3).
 */
import { randomBytes } from '../../../shared/ids.ts';
import { err, ok, type Result } from '../../../shared/result.ts';
import { validarPostulacion, type ErrorFormulario } from '../domain/formulario.ts';
import { decidirDedupe, generarFolio, inicioVentanaDedupe } from '../domain/lead.ts';
import { evaluarLimiteEnvio } from '../domain/otp.ts';
import { Revertir, UNA_HORA_MS, canalHabilitado, emitirOtp, enTransaccion, hmacIp, hmacTelefono } from './comun.ts';
import type { CanalOtp } from '../domain/otp.ts';
import type { Contexto, DatosLead, DepsCaptacion } from './puertos.ts';

export interface PostulacionAceptada {
  leadId: string;
  folio: string;
  reutilizado: boolean;
  cita: { id: string; inicio: string; retenidaHasta: string };
  otp: { expiraEn: string; reenviosRestantes: number; canal: CanalOtp };
}

export type ErrorPostular =
  | ErrorFormulario
  | { codigo: 'ANTIBOT_INVALIDO' | 'ANTIBOT_NO_DISPONIBLE' | 'VACANTE_NO_ENCONTRADA' | 'LIMITE_TELEFONO' | 'LIMITE_IP' | 'WHATSAPP_INVALIDO' | 'VERIFICADOR_NO_DISPONIBLE' | 'EVENTO_DUPLICADO' | 'CANAL_NO_DISPONIBLE' }
  | { codigo: 'SLOT_LLENO' | 'CUPO_DIARIO' | 'SLOT_INVALIDO' }
  | { codigo: 'YA_POSTULADO'; folio: string };

const MAX_REINTENTOS_FOLIO = 5;

export async function postular(deps: DepsCaptacion, entrada: unknown, ctx: Contexto): Promise<Result<PostulacionAceptada, ErrorPostular>> {
  const log = deps.logger.child({ caso: 'postular', correlation_id: ctx.correlationId });
  const slug = typeof entrada === 'object' && entrada !== null && typeof (entrada as { vacante?: unknown }).vacante === 'string' ? (entrada as { vacante: string }).vacante : null;
  const preguntas = slug ? deps.formularios.preguntas(slug) : null;
  if (!slug || !preguntas) return err({ codigo: 'VACANTE_NO_ENCONTRADA' });

  const v = validarPostulacion(entrada, preguntas);
  if (!v.ok) {
    log.info('postulacion_rechazada', { motivo: v.error.codigo, campos: v.error.campos.map((c) => c.campo) });
    return v;
  }
  const p = v.value;
  if (!canalHabilitado(deps, p.canalOtp)) return err({ codigo: 'CANAL_NO_DISPONIBLE' });

  try {
    if (!(await deps.antiBot.verificar(p.turnstileToken, ctx.ip))) return err({ codigo: 'ANTIBOT_INVALIDO' });
  } catch (e) {
    log.warn('antibot_no_disponible', { error: String(e) });
    return err({ codigo: 'ANTIBOT_NO_DISPONIBLE' });
  }

  const vacante = await deps.repo(deps.sql).buscarVacante(p.vacanteSlug);
  if (!vacante) return err({ codigo: 'VACANTE_NO_ENCONTRADA' });

  const ahora = deps.clock.now();
  const [telefonoHmac, ipHmac] = await Promise.all([hmacTelefono(deps.hmacPepper, p.telefonoE164), hmacIp(deps.hmacPepper, ctx.ip)]);
  const repo = deps.repo(deps.sql);

  const limite = evaluarLimiteEnvio(await repo.contarEnvios('otp', { telefonoHmac, ipHmac, desde: new Date(ahora.getTime() - UNA_HORA_MS) }));
  if (!limite.ok) {
    log.warn('rate_limit', { motivo: limite.error });
    return err({ codigo: limite.error });
  }

  const previo = decidirDedupe(await repo.buscarLeadDedupe(vacante.id, telefonoHmac, p.eventId, inicioVentanaDedupe(ahora)));
  if (previo.accion === 'ya_postulado') return yaPostulado(deps, previo.leadId);

  // P7: si el código va por WhatsApp, el número debe existir en WhatsApp antes de retener o enviar.
  // Por SMS o correo no se consulta: es la salida para quien no tiene WhatsApp o no le llega.
  if (p.canalOtp === 'whatsapp') {
    try {
      if (!(await deps.whatsapp.existeEnWhatsApp(p.telefonoE164))) {
        log.info('whatsapp_invalido', { vacante_id: vacante.id });
        return err({ codigo: 'WHATSAPP_INVALIDO' });
      }
    } catch (e) {
      log.warn('verificador_whatsapp_no_disponible', { error: String(e) });
      return err({ codigo: 'VERIFICADOR_NO_DISPONIBLE' });
    }
  }

  const datos: DatosLead = {
    nombre: p.nombre, nombrePila: p.nombrePila, telefonoE164: p.telefonoE164, telefonoHmac, email: p.email, respuestas: p.respuestas,
    consentimientoVersion: p.consentimientoVersion, atribucion: p.atribucion as Record<string, string>, visitorId: p.atribucion.visitor_id ?? null,
  };

  const r = await enTransaccion<Result<PostulacionAceptada, ErrorPostular>, ErrorPostular>(deps, async (repoTx, tx) => {
    await repoTx.bloquearTelefono(vacante.id, telefonoHmac);
    const existente = await repoTx.buscarLeadDedupe(vacante.id, telefonoHmac, p.eventId, inicioVentanaDedupe(ahora));
    const decision = decidirDedupe(existente);
    if (decision.accion === 'ya_postulado') throw new Revertir<ErrorPostular>({ codigo: 'YA_POSTULADO', folio: existente!.folio });

    let leadId: string;
    let folio: string;
    if (decision.accion === 'reutilizar' && existente) {
      leadId = existente.id;
      folio = existente.folio;
      await repoTx.reutilizarLead(leadId, datos, ahora);
      if (existente.citaId) await deps.agenda.liberar(tx, { citaId: existente.citaId, motivo: 'REPOSTULACION' });
    } else {
      if (await repoTx.existeEventId(p.eventId)) throw new Revertir<ErrorPostular>({ codigo: 'EVENTO_DUPLICADO' });
      let id: string | null = null;
      folio = '';
      for (let i = 0; i < MAX_REINTENTOS_FOLIO && !id; i++) {
        folio = generarFolio(deps.random ?? randomBytes);
        id = await repoTx.insertarLead({ ...datos, clienteId: vacante.clienteId, vacanteId: vacante.id, folio, eventId: p.eventId, ahora });
      }
      if (!id) throw new Error('No se pudo generar un folio único');
      leadId = id;
    }

    const ret = await deps.agenda.retener(tx, { vacanteId: vacante.id, leadId, inicio: p.slotInicio });
    if (!ret.ok) throw new Revertir<ErrorPostular>({ codigo: ret.error === 'VACANTE_NO_ENCONTRADA' ? 'VACANTE_NO_ENCONTRADA' : ret.error });
    await repoTx.asignarCita(leadId, ret.value.citaId, p.slotInicio, ahora);

    const otp = await emitirOtp(deps, repoTx, tx, { leadId, clienteId: vacante.clienteId, vacanteId: vacante.id, folio, telefonoHmac, canal: p.canalOtp }, ctx, ipHmac);

    if (decision.accion === 'crear') {
      await repoTx.publicarEvento('LeadCreado', {
        lead_id: leadId, vacante_id: vacante.id, cliente_id: vacante.clienteId, folio, event_id: p.eventId,
        visitor_id: p.atribucion.visitor_id ?? null, origen: p.atribucion.origen ?? p.atribucion.utm_source ?? null,
      }, vacante.clienteId, ctx.correlationId);
    }

    return ok({
      leadId,
      folio,
      reutilizado: decision.accion === 'reutilizar',
      cita: { id: ret.value.citaId, inicio: p.slotInicio, retenidaHasta: ret.value.expiraEn },
      otp: { expiraEn: otp.expiraEn.toISOString(), reenviosRestantes: limite.value.restantesTelefono, canal: p.canalOtp },
    });
  });

  if (r.ok) log.info('lead_postulado', { lead_id: r.value.leadId, vacante_id: vacante.id, reutilizado: r.value.reutilizado });
  else log.info('postulacion_no_completada', { motivo: r.error.codigo, vacante_id: vacante.id });
  return r;
}

async function yaPostulado(deps: DepsCaptacion, leadId: string): Promise<Result<never, ErrorPostular>> {
  const l = await deps.repo(deps.sql).obtenerLead(leadId);
  return err({ codigo: 'YA_POSTULADO', folio: l?.folio ?? '' });
}
