/**
 * Cifrado del código OTP mientras espera en la cola (AES-256-GCM, clave OTP_ENC_KEY en base64).
 * Formato: `v1.<iv base64url>.<ciphertext+tag base64url>`. El worker descifra solo al enviar.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64ToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const bytesToB64Url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function importarClave(claveBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64ToBytes(claveBase64);
  } catch {
    throw new Error('OTP_ENC_KEY: clave base64 inválida');
  }
  if (raw.length !== 32) throw new Error('OTP_ENC_KEY: la clave debe tener 32 bytes');
  return globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function cifrarCodigoOtp(codigo: string, claveBase64: string): Promise<string> {
  if (!/^\d{4,8}$/.test(codigo)) throw new Error('código OTP inválido');
  const clave = await importarClave(claveBase64);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clave, enc.encode(codigo)));
  return `v1.${bytesToB64Url(iv)}.${bytesToB64Url(ct)}`;
}

export async function descifrarCodigoOtp(cifrado: string, claveBase64: string): Promise<string> {
  const partes = cifrado.split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') throw new Error('OTP cifrado: formato desconocido');
  const clave = await importarClave(claveBase64);
  const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(partes[1]!) }, clave, b64ToBytes(partes[2]!));
  return dec.decode(pt);
}
