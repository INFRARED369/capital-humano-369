/**
 * EmailPort sobre SMTP. El transporte se inyecta (en Deno: `npm:nodemailer` createTransport con SMTP_*),
 * así el dominio no depende de un paquete SMTP y se prueba con un transporte falso.
 */
import type { EmailPort, ResultadoEnvio } from '../application/puertos.ts';

export interface TransporteSmtp {
  sendMail(o: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
}

/**
 * Texto de la respuesta SMTP sin datos personales (se quitan direcciones y lo que va entre <>), para que la
 * bitácora diga POR QUÉ falló (p. ej. "5.7.1 Sender is not allowed to relay emails") y no solo el código.
 */
export function motivoSmtp(code: number, respuesta: unknown): string {
  const texto = typeof respuesta === 'string'
    ? respuesta.replace(/<[^>]*>/g, '').replace(/\S+@\S+/g, '').replace(new RegExp(`^\\s*${code}[\\s-]*`), '').replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  return texto ? `SMTP_${code}: ${texto}` : `SMTP_${code}`;
}

export function crearEmailSmtpAdapter(cfg: { remitente: string }, transporte: TransporteSmtp): EmailPort {
  return {
    proveedor: 'smtp',
    async enviar({ para, asunto, texto }): Promise<ResultadoEnvio> {
      if (/[\r\n]/.test(asunto) || /[\r\n]/.test(para)) return { ok: false, error: { motivo: 'CABECERA_INVALIDA', permanente: true } };
      try {
        const r = await transporte.sendMail({ from: cfg.remitente, to: para, subject: asunto, text: texto });
        return { ok: true, value: { proveedorId: r.messageId ?? null } };
      } catch (e) {
        const { responseCode: code, response } = e as { responseCode?: number; response?: unknown };
        if (typeof code === 'number') return { ok: false, error: { motivo: motivoSmtp(code, response), permanente: code >= 500 } };
        return { ok: false, error: { motivo: 'SMTP_RED', permanente: false } };
      }
    },
  };
}
