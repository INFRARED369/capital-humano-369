/**
 * Primitivas criptográficas portables (Node ≥ 20, Deno y navegador vía WebCrypto).
 * NFR-SEG-04: SHA-256 para CAPI; HMAC con pepper para deduplicación y opt-out.
 */
const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(input)));
}

export async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  if (!secret) throw new Error('HMAC sin secreto');
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(input)));
}

/** Comparación en tiempo constante (independiente de dónde difieran). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Normaliza un teléfono mexicano a E.164 sin '+': 52 + 10 dígitos. */
export function normalizarTelefonoMx(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('52') ? digits.slice(2) : digits.length === 13 && digits.startsWith('521') ? digits.slice(3) : digits;
  return /^\d{10}$/.test(ten) ? `52${ten}` : null;
}
