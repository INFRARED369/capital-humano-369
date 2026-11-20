#!/usr/bin/env node
/**
 * Escáner de secretos para el export estático (S5, NFR-SEG-02).
 * Uso: node scripts/scan-secrets.mjs apps/web/out
 * Sale con 0 si no hay hallazgos, 1 si los hay y 2 si el directorio no existe.
 * Nunca imprime el secreto completo (solo un prefijo).
 *
 * Lo que SÍ puede viajar al navegador y no se reporta: la anon key de Supabase (JWT con
 * role=anon), las publishable keys `sb_publishable_…`, site keys de Turnstile, IDs de Pixel/GA4.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

/** Variables que solo existen en edge functions / Vault (src/CONTRATOS.md). */
const VARIABLES_SERVIDOR = [
  'SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'SUPABASE_DB_PASSWORD', 'SUPABASE_ACCESS_TOKEN',
  'HMAC_PEPPER', 'OTP_ENC_KEY', 'LINKS_SECRET', 'TURNSTILE_SECRET',
  'EVOLUTION_API_KEY', 'EVOLUTION_WEBHOOK_SECRET',
  'SMTP_PASS', 'SMTP_PASSWORD', 'SMTP_USER', 'NBX_API_KEY', 'NBX_API_SECRET', 'NBX_WEBHOOK_SECRET',
  'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'META_CAPI_TOKEN', 'GA4_API_SECRET', 'SSH_PRIVATE_KEY',
];

function decodificarPayloadJwt(token) {
  try {
    const parte = token.split('.')[1];
    return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** @type {Array<{ id: string; descripcion: string; re: RegExp; esSecreto?: (m: string) => boolean }>} */
export const REGLAS = [
  {
    id: 'jwt-no-anon',
    descripcion: 'JWT cuyo rol no es anon (p. ej. service_role)',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g,
    esSecreto: (m) => decodificarPayloadJwt(m)?.role !== 'anon',
  },
  { id: 'supabase-secret-key', descripcion: 'Secret key de Supabase (sb_secret_)', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { id: 'sk-key', descripcion: 'Llave secreta tipo sk_ / sk-', re: /\bsk(?:_(?:live|test))?_[A-Za-z0-9]{16,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'meta-token', descripcion: 'Access token de Meta (EAA…)', re: /\bEAA[A-Za-z0-9]{30,}/g },
  { id: 'zoho-token', descripcion: 'Token o client id de Zoho (1000.…)', re: /\b1000\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}(?:\.[A-Za-z0-9]{16,})?/g },
  { id: 'llave-privada', descripcion: 'Llave privada PEM', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  {
    id: 'variable-servidor',
    descripcion: 'Variable de entorno exclusiva del servidor presente en el bundle',
    re: new RegExp(`\\b(?:${VARIABLES_SERVIDOR.join('|')})\\b`, 'g'),
  },
  { id: 'url-con-credenciales', descripcion: 'URL de base de datos con contraseña', re: /\b(?:postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:/@"'`]+:[^\s@"'`]+@/g },
  { id: 'aws-access-key', descripcion: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', descripcion: 'Token de GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
];

const EXT_BINARIAS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.mp4', '.webm', '.mov', '.mp3', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.gz', '.br']);
const MAX_BYTES_TEXTO = 10 * 1024 * 1024;

const muestra = (m) => `${m.slice(0, 6)}…(${m.length})`;

/** Escanea un texto y devuelve los hallazgos. */
export function escanearTexto(texto, archivo) {
  const hallazgos = [];
  for (const regla of REGLAS) {
    for (const m of texto.matchAll(regla.re)) {
      if (regla.esSecreto && !regla.esSecreto(m[0])) continue;
      const linea = texto.slice(0, m.index).split('\n').length;
      hallazgos.push({ regla: regla.id, descripcion: regla.descripcion, archivo, linea, muestra: muestra(m[0]) });
    }
  }
  return hallazgos;
}

async function* recorrer(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) yield* recorrer(ruta);
    else if (e.isFile()) yield ruta;
  }
}

/** Escanea recursivamente un directorio (rutas relativas con '/'). */
export async function escanearDirectorio(dir) {
  const hallazgos = [];
  for await (const ruta of recorrer(dir)) {
    const rel = relative(dir, ruta).split(sep).join('/');
    if (/^\.env(\..*)?$/.test(basename(ruta))) {
      hallazgos.push({ regla: 'archivo-env', descripcion: 'Archivo .env publicado', archivo: rel, linea: 0, muestra: '' });
      continue;
    }
    if (EXT_BINARIAS.has(extname(ruta).toLowerCase())) continue;
    if ((await stat(ruta)).size > MAX_BYTES_TEXTO) continue;
    hallazgos.push(...escanearTexto(await readFile(ruta, 'utf8'), rel));
  }
  return hallazgos;
}

async function main(argv) {
  const dir = argv[0] ?? 'apps/web/out';
  if (!existsSync(dir)) {
    console.error(`scan-secrets: no existe el directorio ${dir} (¿corriste npm run build?)`);
    return 2;
  }
  const hallazgos = (await stat(dir)).isFile() ? escanearTexto(await readFile(dir, 'utf8'), dir) : await escanearDirectorio(dir);
  if (hallazgos.length === 0) {
    console.log(`scan-secrets: sin secretos en ${dir}`);
    return 0;
  }
  for (const h of hallazgos) console.error(`✗ ${h.regla} · ${h.archivo}:${h.linea} · ${h.descripcion} · ${h.muestra}`);
  console.error(`scan-secrets: ${hallazgos.length} hallazgo(s) en ${dir}. El despliegue se bloquea (NFR-SEG-02).`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
