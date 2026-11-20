/**
 * Adaptador SMS NBX (SMS nacional, Q-1). Contrato del proveedor:
 *   POST {NBX_API_URL}/v2/sms/send · Authorization: Basic <token>
 *   { "phone": "5500001234", "msg": "...", "id": "opcional", "sender": "opcional" }
 * - phone: 10 dígitos (sin lada de país).
 * - msg: alfabeto GSM 03.38, máximo 160 caracteres (más de un mensaje requiere habilitarlo con NBX → `maxCaracteres`).
 * - sender: shortcode o máscara; si no se envía, NBX usa el default de la cuenta.
 * La respuesta no está documentada: se leen id/costo si vienen y se clasifica por código HTTP.
 * NBX autoriza por IP y las Edge Functions no tienen IP de salida fija: en producción NBX_API_URL apunta al
 * relay de n8n con IP fija (infra/n8n/nbx-sms-relay.json), que reenvía phone/msg/sender y devuelve la respuesta de NBX tal cual.
 */
import { z } from 'zod';
import type { ResultadoEnvio, SmsPort } from '../application/puertos.ts';
import { errorHttpConDetalle, exigirHttps, leerJson, postJson } from './http-proveedor.ts';

export const NbxRespuestaSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  message_id: z.union([z.string(), z.number()]).optional(),
  cost: z.number().nonnegative().optional(),
});

export interface NbxConfig {
  /** Base de la API (p. ej. https://api.nbx.mx) o la URL completa terminada en /v2/sms/send. */
  url: string;
  /** Token de autenticación (va como `Authorization: Basic <token>`). */
  apiKey: string;
  /** Shortcode o máscara; opcional. */
  remitente?: string;
  /** Límite de caracteres GSM por envío (160 por defecto; más solo si NBX habilitó mensajes concatenados). */
  maxCaracteres?: number;
}

const RUTA_ENVIO = '/v2/sms/send';
export const NBX_MAX_CARACTERES = 160;

// GSM 03.38: alfabeto básico (1 septeto) y tabla de extensión (2 septetos: ESC + carácter).
const GSM_BASICO = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENSION = new Set('^{}\\[~]|€');
const EQUIVALENTES: Record<string, string> = {
  '·': '-', '•': '-', '–': '-', '—': '-', '‐': '-', '“': '"', '”': '"', '«': '"', '»': '"', '‘': "'", '’': "'", '…': '...',
  ' ': ' ', '\t': ' ', '`': "'", '´': "'", 'º': 'o', 'ª': 'a', '°': 'o',
};

/**
 * Convierte el texto al alfabeto GSM 03.38: conserva lo que ya es GSM (é, ñ, ü, ¿, ¡…), quita acentos que GSM
 * no tiene (á, í, ó, ú → a, i, o, u), sustituye tipografía común y descarta el resto (emojis, etc.).
 */
export function aGsm(texto: string): string {
  let r = '';
  for (const c of texto.normalize('NFC')) {
    if (GSM_BASICO.has(c) || GSM_EXTENSION.has(c)) r += c;
    else if (EQUIVALENTES[c] !== undefined) r += EQUIVALENTES[c];
    else {
      const base = c.normalize('NFD').replace(/\p{M}/gu, '');
      if (base && [...base].every((b) => GSM_BASICO.has(b))) r += base;
    }
  }
  return r;
}

/** Longitud en septetos GSM (los caracteres de la tabla de extensión cuentan doble). */
export const largoGsm = (texto: string) => [...texto].reduce((n, c) => n + (GSM_EXTENSION.has(c) ? 2 : 1), 0);

/** E.164 de México (52 + 10 dígitos) → los 10 dígitos que pide NBX. */
export function telefonoNbx(telefonoE164: string): string | null {
  const d = telefonoE164.replace(/\D/g, '');
  const diez = d.length === 12 && d.startsWith('52') ? d.slice(2) : d;
  return /^\d{10}$/.test(diez) ? diez : null;
}

export function crearNbxSmsAdapter(cfg: NbxConfig, fetchImpl: typeof fetch): SmsPort {
  const base = exigirHttps(cfg.url, 'NBX_API_URL');
  const url = base.endsWith(RUTA_ENVIO) ? base : `${base}${RUTA_ENVIO}`;
  if (!cfg.apiKey) throw new Error('NBX: falta NBX_API_KEY');
  const authorization = /^basic\s/i.test(cfg.apiKey) ? cfg.apiKey : `Basic ${cfg.apiKey}`;
  const max = cfg.maxCaracteres ?? NBX_MAX_CARACTERES;
  return {
    proveedor: 'nbx',
    async enviarSms(telefonoE164, texto): Promise<ResultadoEnvio> {
      const phone = telefonoNbx(telefonoE164);
      if (!phone) return { ok: false, error: { motivo: 'TELEFONO_INVALIDO', permanente: true } };
      const msg = aGsm(texto).trim();
      // Sin recortar: un SMS truncado podría cortar un link o el código. Se registra como falla definitiva.
      if (largoGsm(msg) > max) return { ok: false, error: { motivo: `SMS_EXCEDE_${max}`, permanente: true } };
      const body: Record<string, string> = { phone, msg };
      if (cfg.remitente) body.sender = cfg.remitente;
      const r = await postJson(fetchImpl, url, { authorization }, body);
      if (!r) return { ok: false, error: { motivo: 'RED', permanente: false } };
      if (!r.ok) return { ok: false, error: await errorHttpConDetalle(r) };
      const p = NbxRespuestaSchema.safeParse(await leerJson(r));
      const datos = p.success ? p.data : {};
      const id = datos.id ?? datos.message_id;
      return { ok: true, value: { proveedorId: id === undefined ? null : String(id), ...(datos.cost !== undefined ? { costoMxn: datos.cost } : {}) } };
    },
  };
}
