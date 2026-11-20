/**
 * Verificación de la sesión del panel contra Supabase Auth (GET /auth/v1/user). Además de la firma,
 * detecta sesiones revocadas (logout, usuario borrado). El gateway de Supabase ya exige un JWT válido
 * (`verify_jwt = true` en config.toml); esto es la segunda barrera y la que da el `sub` confiable.
 */
import type { VerificadorSesion } from '../application/puertos.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMA_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function extraerBearer(h: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(h ?? '');
  return m && m[1]!.length <= 4096 ? m[1]! : null;
}

export function crearVerificadorSupabaseAuth(cfg: { url: string; anonKey: string; fetch?: typeof fetch }): VerificadorSesion {
  const base = cfg.url.replace(/\/+$/, '');
  const f = cfg.fetch ?? globalThis.fetch;
  return {
    async verificar(token) {
      if (!FORMA_JWT.test(token)) return null;
      const res = await f(`${base}/auth/v1/user`, { headers: { apikey: cfg.anonKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      if (res.status !== 200) return null;
      const u = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return typeof u?.id === 'string' && UUID.test(u.id) ? { usuarioId: u.id } : null;
    },
  };
}
