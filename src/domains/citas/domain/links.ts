/**
 * Links firmados para cancelar o reprogramar (CIT-11, C15). Formato del token:
 *   base64url(JSON {c: citaId, a: accion, e: expira epoch s}) + '.' + HMAC-SHA256 hex
 * La firma cubre un prefijo de dominio para que el secreto no sirva para otros tokens.
 */
import type { Clock } from '@shared/clock.ts';
import { hmacSha256Hex, timingSafeEqual } from '@shared/crypto.ts';
import { UUID_RE } from '@shared/ids.ts';
import { err, ok, type Result } from '@shared/result.ts';

export type AccionGestion = 'cancelar' | 'reprogramar';
export interface LinkGestion { citaId: string; accion: AccionGestion; expiraEn: string }
export type ErrorToken = 'TOKEN_INVALIDO' | 'TOKEN_VENCIDO';

const PREFIJO = 'citas.gestion.v1.';
const SECRETO_MIN = 32;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(texto: string): string {
  const bin = Array.from(enc.encode(texto), (b) => String.fromCharCode(b)).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function desdeB64url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

const esAccion = (a: unknown): a is AccionGestion => a === 'cancelar' || a === 'reprogramar';

export async function firmarLinkGestion(link: LinkGestion, secreto: string): Promise<string> {
  if (!secreto || secreto.length < SECRETO_MIN) throw new Error('LINKS_SECRET debe tener al menos 32 caracteres');
  const expira = Date.parse(link.expiraEn);
  if (!UUID_RE.test(link.citaId) || !esAccion(link.accion) || Number.isNaN(expira)) throw new Error('Datos de link inválidos');
  const payload = b64url(JSON.stringify({ c: link.citaId, a: link.accion, e: Math.floor(expira / 1000) }));
  return `${payload}.${await hmacSha256Hex(secreto, PREFIJO + payload)}`;
}

export async function verificarLinkGestion(token: string, secreto: string, clock: Clock): Promise<Result<LinkGestion, ErrorToken>> {
  if (!secreto || secreto.length < SECRETO_MIN || typeof token !== 'string' || token.length > 512) return err('TOKEN_INVALIDO');
  const partes = token.split('.');
  if (partes.length !== 2) return err('TOKEN_INVALIDO');
  const [payload, firma] = partes as [string, string];
  if (!payload || !/^[0-9a-f]{64}$/.test(firma)) return err('TOKEN_INVALIDO');
  if (!timingSafeEqual(firma, await hmacSha256Hex(secreto, PREFIJO + payload))) return err('TOKEN_INVALIDO');

  const json = desdeB64url(payload);
  let datos: { c?: unknown; a?: unknown; e?: unknown };
  try {
    datos = JSON.parse(json ?? '');
  } catch {
    return err('TOKEN_INVALIDO');
  }
  if (typeof datos.c !== 'string' || !UUID_RE.test(datos.c) || !esAccion(datos.a) || typeof datos.e !== 'number') return err('TOKEN_INVALIDO');
  if (clock.now().getTime() >= datos.e * 1000) return err('TOKEN_VENCIDO');
  return ok({ citaId: datos.c, accion: datos.a, expiraEn: new Date(datos.e * 1000).toISOString() });
}
