import type { SqlClient } from '@shared/sql.ts';
import { hmacSha256Hex, normalizarTelefonoMx } from '@shared/crypto.ts';

/** Normaliza (E.164 sin '+', MX con 52 + 10 dígitos) antes del HMAC para que la baja coincida siempre. */
export function normalizarTelefono(telefono: string): string {
  return normalizarTelefonoMx(telefono) ?? telefono.replace(/\D/g, '');
}

/** HMAC_PEPPER sobre el teléfono normalizado. El mismo cálculo sirve para la prueba de consentimiento. */
export const hmacTelefono = (pepper: string, telefono: string): Promise<string> => hmacSha256Hex(pepper, normalizarTelefono(telefono));

export type SolicitudOptOut =
  | { telefonoE164: string; telefonoHmac?: never; clienteId: string | null; origen: 'webhook' | 'arco' | 'panel' }
  | { telefonoHmac: string; telefonoE164?: never; clienteId: string | null; origen: 'webhook' | 'arco' | 'panel' };

/** Opt-out permanente (COM-05, ARCO). Solo se guarda el HMAC. Devuelve true si es nuevo. */
export async function registrarOptOut(sql: SqlClient, s: SolicitudOptOut, pepper: string): Promise<boolean> {
  const hmac = s.telefonoHmac ?? (await hmacTelefono(pepper, s.telefonoE164!));
  if (!/^[0-9a-f]{64}$/.test(hmac)) throw new Error('HMAC de teléfono inválido');
  const { rows } = await sql.query<{ nuevo: boolean }>(`select comunicacion.registrar_opt_out($1, $2::uuid, $3) as nuevo`, [hmac, s.clienteId, s.origen]);
  return rows[0]!.nuevo;
}
