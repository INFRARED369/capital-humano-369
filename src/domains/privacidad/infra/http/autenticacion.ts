/**
 * Autenticación de la edge function `arco`: solo un admin con JWT de Supabase Auth (y MFA, aal2) o la
 * service key. El token se valida contra Supabase Auth (`/auth/v1/user`): no se confía en el payload
 * sin verificar, aunque `verify_jwt` también esté activo en el gateway.
 */
import { timingSafeEqual } from '@shared/crypto.ts';
import type { SqlClient } from '@shared/sql.ts';

export type Autenticado = { tipo: 'admin'; userId: string } | { tipo: 'servicio' };
export type FallaAuth = 'NO_AUTENTICADO' | 'PROHIBIDO' | 'MFA_REQUERIDA';

export interface UsuarioVerificado {
  userId: string;
  aal: string | null;
}

export interface ConfigAutenticador {
  serviceKey: string;
  verificarToken: (token: string) => Promise<UsuarioVerificado | null>;
  esAdmin: (userId: string) => Promise<boolean>;
  /** Exigir MFA (aal2) a los admins. Por defecto true. */
  requiereMfa?: boolean;
}

export function crearAutenticadorArco(c: ConfigAutenticador): (req: Request) => Promise<Autenticado | FallaAuth> {
  return async (req) => {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token || token.length > 4096) return 'NO_AUTENTICADO';
    if (c.serviceKey && timingSafeEqual(token, c.serviceKey)) return { tipo: 'servicio' };
    const u = await c.verificarToken(token);
    if (!u) return 'NO_AUTENTICADO';
    if (!(await c.esAdmin(u.userId))) return 'PROHIBIDO';
    if ((c.requiereMfa ?? true) && u.aal !== 'aal2') return 'MFA_REQUERIDA';
    return { tipo: 'admin', userId: u.userId };
  };
}

/** Lee un claim del payload de un JWT YA verificado por Supabase Auth (no valida la firma). */
export function claimDe(token: string, claim: string): string | null {
  const parte = token.split('.')[1];
  if (!parte) return null;
  try {
    const json = JSON.parse(atob(parte.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    return typeof json[claim] === 'string' ? (json[claim] as string) : null;
  } catch {
    return null;
  }
}

/** Verifica el token con Supabase Auth. Devuelve null ante cualquier respuesta distinta de 200. */
export function crearVerificadorSupabase(cfg: { url: string; apiKey: string; fetch: typeof fetch; timeoutMs?: number }): (token: string) => Promise<UsuarioVerificado | null> {
  return async (token) => {
    try {
      const res = await cfg.fetch(`${cfg.url.replace(/\/$/, '')}/auth/v1/user`, {
        headers: { authorization: `Bearer ${token}`, apikey: cfg.apiKey },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 5000),
      });
      if (res.status !== 200) return null;
      const u = (await res.json()) as { id?: unknown };
      return typeof u.id === 'string' ? { userId: u.id, aal: claimDe(token, 'aal') } : null;
    } catch {
      return null;
    }
  };
}

/** Rol admin del panel (shared.usuarios_roles, kernel compartido). */
export function crearEsAdminSql(sql: SqlClient): (userId: string) => Promise<boolean> {
  return async (userId) => {
    const { rows } = await sql.query<{ admin: boolean }>(
      `select exists (select 1 from shared.usuarios_roles where user_id = $1::uuid and rol = 'admin') as admin`, [userId]);
    return rows[0]?.admin === true;
  };
}
