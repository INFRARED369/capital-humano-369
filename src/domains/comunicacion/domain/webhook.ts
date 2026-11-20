/**
 * NFR-SEG-05 / M5 · Firma de webhooks: `sha256=` + HMAC-SHA256(secreto, `${timestamp}.${cuerpo}`),
 * con tolerancia de reloj (anti-replay por ventana) — la deduplicación fina va en comunicacion.webhooks_vistos.
 */
import { hmacSha256Hex, timingSafeEqual } from '@shared/crypto.ts';
import { err, ok, type Result } from '@shared/result.ts';

export type ErrorFirma = 'FIRMA_AUSENTE' | 'FIRMA_INVALIDA' | 'EXPIRADO';

export async function firmarWebhook(secreto: string, timestamp: string, cuerpo: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secreto, `${timestamp}.${cuerpo}`)}`;
}

export async function verificarWebhook(i: {
  secreto: string;
  firma: string | null;
  timestamp: string | null;
  cuerpo: string;
  ahora: Date;
  toleranciaSeg?: number;
}): Promise<Result<void, ErrorFirma>> {
  if (!i.firma || !i.timestamp) return err('FIRMA_AUSENTE');
  const ts = /^\d{9,11}$/.test(i.timestamp) ? Number(i.timestamp) : NaN;
  if (!Number.isFinite(ts) || Math.abs(i.ahora.getTime() / 1000 - ts) > (i.toleranciaSeg ?? 300)) return err('EXPIRADO');
  if (!i.secreto) return err('FIRMA_INVALIDA');
  const esperada = await firmarWebhook(i.secreto, i.timestamp, i.cuerpo);
  return timingSafeEqual(esperada, i.firma) ? ok(undefined) : err('FIRMA_INVALIDA');
}

/**
 * NFR-SEG-05 · Evolution API v2 NO firma sus webhooks. En su lugar se configura en la instancia
 * (`POST /webhook/set/{instance}` → `webhook.headers`) una cabecera secreta `x-369-webhook-token`
 * que se compara en tiempo constante con EVOLUTION_WEBHOOK_SECRET. Como la cabecera es estática,
 * se complementa con frescura (`date_time` del cuerpo, ±5 min) y anti-replay por id de evento.
 */
export type ErrorToken = 'TOKEN_AUSENTE' | 'TOKEN_INVALIDO';

export function verificarTokenWebhook(esperado: string, recibido: string | null): Result<void, ErrorToken> {
  if (!recibido) return err('TOKEN_AUSENTE');
  if (!esperado) return err('TOKEN_INVALIDO');
  return timingSafeEqual(esperado, recibido) ? ok(undefined) : err('TOKEN_INVALIDO');
}

const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Frescura del evento. Evolution v2 arma `date_time` con la hora LOCAL de su servidor y sufijo `Z`
 * (`new Date(Date.now() - tzoffset).toISOString()`): `desfaseMin` es el desfase UTC de ese servidor
 * (CDMX = -360; 0 si Evolution corre con TZ=UTC, que es lo recomendado).
 */
export function verificarFrescura(
  fecha: unknown,
  ahora: Date,
  opts: { toleranciaSeg?: number; desfaseMin?: number } = {},
): Result<void, 'EXPIRADO'> {
  if (typeof fecha !== 'string' || !RE_ISO.test(fecha)) return err('EXPIRADO');
  const conZona = /(?:Z|[+-]\d{2}:?\d{2})$/.test(fecha) ? fecha : `${fecha}Z`;
  const ms = Date.parse(conZona) - (opts.desfaseMin ?? 0) * 60_000;
  if (!Number.isFinite(ms) || Math.abs(ahora.getTime() - ms) > (opts.toleranciaSeg ?? 300) * 1000) return err('EXPIRADO');
  return ok(undefined);
}

const texto = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * Id estable de un evento de Evolution para anti-replay (`comunicacion.webhooks_vistos`):
 * `<evento>:<id del mensaje>:<estado>` (un mismo mensaje cambia de estado varias veces).
 * null si el evento no trae id de mensaje (se usa el sha256 del cuerpo).
 */
export function idEventoEvolution(datos: unknown): string | null {
  const ev = obj(datos);
  const nombre = texto(ev?.event)?.toLowerCase().replace(/_/g, '.');
  const data = obj(ev?.data);
  if (!nombre || !data) return null;
  const id = texto(data.keyId) ?? texto(obj(data.key)?.id) ?? texto(data.messageId);
  if (!id) return null;
  return `${nombre}:${id}:${texto(data.status) ?? ''}`.slice(0, 128);
}
