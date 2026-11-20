/**
 * TokenCachePort sobre citas.zoho_token_cache (una fila). El access token se guarda cifrado con AES-256-GCM;
 * la llave se deriva de ZOHO_CLIENT_SECRET (SHA-256 con etiqueta), que solo vive en el entorno de la función:
 * una fuga de la BD sola no expone el token. Rotar el secreto invalida la caché (se descifra a null y se renueva).
 */
import type { SqlClient } from '@shared/sql.ts';
import type { TokenCachePort } from './zohoCalendarAdapter.ts';

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function llave(secreto: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`zoho-token-cache|${secreto}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function crearTokenCacheSql(sql: SqlClient, secreto: string): TokenCachePort {
  const k = llave(secreto);
  return {
    async leer() {
      const { rows } = await sql.query<{ token_cifrado: string; vence_en: string | Date }>(`select token_cifrado, vence_en from citas.zoho_token_cache where id = 1`);
      const f = rows[0];
      if (!f) return null;
      const [v, iv, ct] = f.token_cifrado.split('.');
      if (v !== 'v1' || !iv || !ct) return null;
      try {
        const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(iv) }, await k, deB64(ct));
        return { token: new TextDecoder().decode(claro), venceEn: new Date(f.vence_en).getTime() };
      } catch {
        return null;
      }
    },
    async guardar(token, venceEn) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await k, enc.encode(token)));
      await sql.query(
        `insert into citas.zoho_token_cache (id, token_cifrado, vence_en) values (1, $1, $2::timestamptz)
         on conflict (id) do update set token_cifrado = excluded.token_cifrado, vence_en = excluded.vence_en, actualizado_en = now()`,
        [`v1.${b64(iv)}.${b64(ct)}`, new Date(venceEn).toISOString()]);
    },
  };
}
