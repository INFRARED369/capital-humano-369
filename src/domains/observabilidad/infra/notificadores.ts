/**
 * Adaptadores de NotificadorAlertasPort (NFR-OBS-01):
 *  - webhook genérico (ALERTAS_WEBHOOK_URL: Slack incoming webhook, Discord, …), payload sin PII;
 *  - correo vía el EmailPort de comunicación (ALERTAS_EMAIL, reutiliza SMTP_*).
 */
import { err, ok } from '@shared/result.ts';
import type { EmailPort } from '@domains/comunicacion/index.ts';
import { formatearAlertas, payloadWebhook } from '../domain/alertas.ts';
import type { NotificadorAlertasPort } from '../application/ejecutar.ts';

export function crearNotificadorWebhook(cfg: { url: string; fetch: typeof fetch; timeoutMs?: number; entorno?: string }): NotificadorAlertasPort {
  if (!/^https:\/\/[^\s]+$/.test(cfg.url)) throw new Error('ALERTAS_WEBHOOK_URL debe ser https');
  return {
    canal: 'webhook',
    async notificar(alertas) {
      try {
        const r = await cfg.fetch(cfg.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloadWebhook(alertas, { entorno: cfg.entorno })),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 5000),
        });
        await r.body?.cancel();
        return r.ok ? ok(undefined) : err(`HTTP_${r.status}`);
      } catch {
        return err('RED');
      }
    },
  };
}

const RE_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Divide "a@x.mx, b@x.mx" (ALERTAS_EMAIL). */
export const destinatariosAlertas = (valor: string | undefined): string[] => (valor ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function crearNotificadorEmail(cfg: { email: EmailPort; para: readonly string[]; entorno?: string }): NotificadorAlertasPort {
  if (cfg.para.length === 0 || !cfg.para.every((p) => RE_EMAIL.test(p))) throw new Error('ALERTAS_EMAIL: lista de correos inválida');
  return {
    canal: 'email',
    async notificar(alertas) {
      const { asunto, texto } = formatearAlertas(alertas, { entorno: cfg.entorno });
      for (const para of cfg.para) {
        const r = await cfg.email.enviar({ para, asunto, texto });
        if (!r.ok) return err(r.error.motivo);
      }
      return ok(undefined);
    },
  };
}
