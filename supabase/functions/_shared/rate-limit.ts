/**
 * Rate limit genérico basado en tabla (NFR-SEG-03), ventana fija.
 * SQL: shared.rate_limit_consumir (migración 00000000000001_plataforma.sql).
 * Las llaves son HMAC con pepper: la tabla nunca guarda teléfonos ni IPs (NFR-SEG-04).
 *
 *   const k = await llaveRateLimit(env.HMAC_PEPPER, 'otp-ip', ctx.ip ?? 'sin-ip');
 *   const r = await consumirCupo(sql, { llave: k, limite: 10, ventanaSeg: 3600 });
 *   if (!r.permitido) return respuestaLimitada(r);
 */
import { hmacSha256Hex } from '@shared/crypto.ts';
import { json } from '@shared/http.ts';
import type { SqlClient } from '@shared/sql.ts';

export interface Cupo {
  permitido: boolean;
  restantes: number;
  reintentarEnSeg: number;
}

export async function llaveRateLimit(pepper: string, ambito: string, valor: string): Promise<string> {
  if (!/^[a-z0-9-]{1,40}$/.test(ambito)) throw new Error('ámbito de rate limit inválido');
  return `${ambito}:${(await hmacSha256Hex(pepper, `${ambito}|${valor}`)).slice(0, 32)}`;
}

export async function consumirCupo(
  sql: SqlClient,
  { llave, limite, ventanaSeg }: { llave: string; limite: number; ventanaSeg: number },
  ahora: () => Date = () => new Date(),
): Promise<Cupo> {
  const { rows } = await sql.query<{ permitido: boolean; conteo: number; reinicia_en: string | Date }>(
    'select * from shared.rate_limit_consumir($1, $2, $3)',
    [llave, limite, ventanaSeg],
  );
  const fila = rows[0];
  if (!fila) throw new Error('rate_limit_consumir sin resultado');
  const reintentarEnSeg = Math.max(0, Math.ceil((new Date(fila.reinicia_en).getTime() - ahora().getTime()) / 1000));
  return { permitido: fila.permitido, restantes: Math.max(0, limite - Number(fila.conteo)), reintentarEnSeg };
}

export function respuestaLimitada(c: Cupo, headers: Record<string, string> = {}): Response {
  return json({ error: 'demasiadas_solicitudes', reintentar_en_seg: c.reintentarEnSeg }, 429, { 'retry-after': String(c.reintentarEnSeg), ...headers });
}
