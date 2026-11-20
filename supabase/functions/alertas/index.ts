/**
 * alertas (NFR-OBS-01, cron cada 5 min): shared.evaluar_alertas → pendientes → notificar → marcar.
 * Autenticación: `Authorization: Bearer <ALERTAS_SECRET | SUPABASE_SERVICE_ROLE_KEY>` (lo manda pg_cron).
 * Canales (opcionales; sin ninguno, las alertas quedan en shared.alertas y en los logs):
 *  - ALERTAS_WEBHOOK_URL: webhook entrante https (Slack, Discord, …). Payload sin PII.
 *  - ALERTAS_EMAIL: lista de correos separada por comas; usa el EmailPort SMTP de comunicación (SMTP_*).
 * ALERTAS_ENTORNO (opcional): etiqueta en el asunto (p. ej. produccion). ALERTAS_CONFIG (opcional): JSON de umbrales.
 */
import nodemailer from 'npm:nodemailer@6.9.16';
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearEmailSmtpAdapter } from '@domains/comunicacion/index.ts';
import {
  crearHandlerAlertas, crearNotificadorEmail, crearNotificadorWebhook, crearRepoAlertasSql, destinatariosAlertas, ejecutarAlertas,
  type NotificadorAlertasPort,
} from '@domains/observabilidad/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL']);
const opc = Deno.env.toObject();
const log = crearLogger({ funcion: 'alertas' });
const sql = sqlDeno(env.SUPABASE_DB_URL);
const entorno = opc.ALERTAS_ENTORNO || undefined;

const notificadores: NotificadorAlertasPort[] = [];
if (opc.ALERTAS_WEBHOOK_URL) notificadores.push(crearNotificadorWebhook({ url: opc.ALERTAS_WEBHOOK_URL, fetch, entorno }));
const para = destinatariosAlertas(opc.ALERTAS_EMAIL);
if (para.length > 0 && opc.SMTP_HOST && opc.SMTP_FROM) {
  const puerto = Number(opc.SMTP_PORT || '587');
  const transporte = nodemailer.createTransport({
    host: opc.SMTP_HOST, port: puerto, secure: puerto === 465, auth: opc.SMTP_USER ? { user: opc.SMTP_USER, pass: opc.SMTP_PASS ?? '' } : undefined,
  });
  notificadores.push(crearNotificadorEmail({ email: crearEmailSmtpAdapter({ remitente: opc.SMTP_FROM }, transporte), para, entorno }));
}

let config: Record<string, number> | undefined;
try {
  config = opc.ALERTAS_CONFIG ? JSON.parse(opc.ALERTAS_CONFIG) : undefined;
} catch {
  log.warn('ALERTAS_CONFIG inválido; se usan los umbrales por defecto');
}

Deno.serve(crearHandlerAlertas({
  secreto: opc.ALERTAS_SECRET || opc.SUPABASE_SERVICE_ROLE_KEY || '',
  log,
  correr: () => ejecutarAlertas({ repo: crearRepoAlertasSql(sql), notificadores, clock: systemClock, log, config }),
}));
