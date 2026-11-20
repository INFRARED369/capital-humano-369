/**
 * comunicacion-worker (cron cada minuto, F3): recupera vencidos → outbox de citas (consumidor 'comunicacion')
 * → cola 'comunicacion' → WhatsApp (Evolution) / correo (SMTP) / SMS (NBX: POST /v2/sms/send, opcional).
 * Autenticación: `Authorization: Bearer <COMUNICACION_WORKER_SECRET | SUPABASE_SERVICE_ROLE_KEY>`.
 * Tarifas por canal (MXN) opcionales: COSTO_WHATSAPP_MXN, COSTO_EMAIL_MXN, COSTO_SMS_MXN.
 * Correo opcional: sin SMTP_HOST el worker arranca igual (WhatsApp sigue saliendo) y los mensajes de correo
 * van a dead letter con CANAL_NO_CONFIGURADO. Si SMTP_HOST existe, SMTP_PORT/USER/PASS/FROM son obligatorios.
 */
import nodemailer from 'npm:nodemailer@6.9.16';
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { obtenerContactoLead } from '@domains/captacion/index.ts';
import { firmarLinkGestion } from '@domains/citas/index.ts';
import {
  correrTrabajoComunicacion, crearContactosDesdeCaptacion, crearEmailSmtpAdapter, crearEvolutionAdapter, crearHandlerWorker,
  crearLinksGestion, crearNbxSmsAdapter, crearReglasVacanteSql, type EmailPort, type SmsPort,
} from '@domains/comunicacion/index.ts';

const env = entornoDeno([
  'SUPABASE_DB_URL', 'HMAC_PEPPER', 'OTP_ENC_KEY', 'LINKS_SECRET', 'ALLOWED_ORIGIN',
  'EVOLUTION_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE',
]);
const opc = Deno.env.toObject();
const log = crearLogger({ funcion: 'comunicacion-worker' });
const sql = sqlDeno(env.SUPABASE_DB_URL);
const tarifa = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);

// NBX (SMS nacional): solo se cablea si existen sus variables. NBX_MAX_CHARS solo si NBX habilitó mensajes concatenados.
const sms: SmsPort | undefined = opc.NBX_API_URL && opc.NBX_API_KEY
  ? crearNbxSmsAdapter({
    url: opc.NBX_API_URL, apiKey: opc.NBX_API_KEY, remitente: opc.NBX_SENDER || undefined,
    maxCaracteres: tarifa(opc.NBX_MAX_CHARS),
  }, fetch)
  : undefined;

function crearEmail(): EmailPort | undefined {
  if (!opc.SMTP_HOST) {
    log.warn('SMTP sin configurar: el canal de correo queda deshabilitado (CANAL_NO_CONFIGURADO)');
    return undefined;
  }
  const smtp = entornoDeno(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
  const transporte = nodemailer.createTransport({
    host: smtp.SMTP_HOST, port: smtp.SMTP_PORT, secure: smtp.SMTP_PORT === 465, auth: { user: smtp.SMTP_USER, pass: smtp.SMTP_PASS },
  });
  return crearEmailSmtpAdapter({ remitente: smtp.SMTP_FROM }, transporte);
}
const email = crearEmail();

Deno.serve(crearHandlerWorker({
  secreto: opc.COMUNICACION_WORKER_SECRET || opc.SUPABASE_SERVICE_ROLE_KEY || '',
  log,
  correr: () => correrTrabajoComunicacion({
    sql,
    clock: systemClock,
    canales: {
      whatsapp: crearEvolutionAdapter({ url: env.EVOLUTION_URL, apiKey: env.EVOLUTION_API_KEY, instancia: env.EVOLUTION_INSTANCE }, fetch),
      email,
      sms,
    },
    contactos: crearContactosDesdeCaptacion(obtenerContactoLead, sql),
    reglas: crearReglasVacanteSql(sql, log),
    reglasEn: (tx) => crearReglasVacanteSql(tx, log),
    links: crearLinksGestion(firmarLinkGestion, env.LINKS_SECRET, env.ALLOWED_ORIGIN[0]!),
    otpKey: env.OTP_ENC_KEY,
    pepper: env.HMAC_PEPPER,
    tarifas: { whatsapp: tarifa(opc.COSTO_WHATSAPP_MXN), email: tarifa(opc.COSTO_EMAIL_MXN), sms: tarifa(opc.COSTO_SMS_MXN) },
    logger: log,
  }),
}));
