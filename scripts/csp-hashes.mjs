#!/usr/bin/env node
/**
 * CSP sin 'unsafe-inline' en script-src (NFR-SEG-07). Tras `next build` (export estático) recorre
 * apps/web/out/**\/*.html, calcula el sha256 de cada <script> inline ejecutable y genera
 * infra/nginx/csp.conf a partir de infra/nginx/csp.plantilla.conf. La misma conf la usan Nginx
 * (snippets/csp.conf, incluida por security-headers.conf) y scripts/serve-out.mjs (E2E y Lighthouse).
 *
 * Uso:
 *   node scripts/csp-hashes.mjs [--out apps/web/out] [--plantilla infra/nginx/csp.plantilla.conf]
 *                               [--destino infra/nginx/csp.conf] [--unir csp-anterior.conf]
 * --unir agrega los hashes de una conf previa (deploy: el HTML viejo sigue válido mientras se sincroniza).
 * Corre solo en `postbuild` y explícitamente en CI después de cada build.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersDe, parsearCsp, parsearNginx } from './lib/nginx-conf.mjs';

export const MARCADOR = '__CSP_SCRIPT_HASHES__';
const RAIZ_REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const RUTAS_DEFECTO = {
  out: join(RAIZ_REPO, 'apps', 'web', 'out'),
  plantilla: join(RAIZ_REPO, 'infra', 'nginx', 'csp.plantilla.conf'),
  destino: join(RAIZ_REPO, 'infra', 'nginx', 'csp.conf'),
};
/** Tipos de <script> que el navegador ejecuta (los demás son bloques de datos: JSON-LD, importmap…). */
const TIPO_EJECUTABLE = /^(?:|text\/javascript|application\/javascript|module)$/i;
/** Encabezados > ~8 KB los cortan algunos proxies; avisar antes. */
const LIMITE_HEADER = 8 * 1024;

/** Contenido exacto de los <script> inline ejecutables (sin src, no vacíos). */
export function scriptsInline(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const tipo = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1] ?? '';
    if (!TIPO_EJECUTABLE.test(tipo)) continue;
    if (m[2]) out.push(m[2]);
  }
  return out;
}

export const hashSha256 = (contenido) => `'sha256-${createHash('sha256').update(contenido, 'utf8').digest('base64')}'`;

function* htmls(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* htmls(p);
    else if (e.name.endsWith('.html')) yield p;
  }
}

/** Hashes únicos y ordenados (salida estable) de todos los HTML de `dirOut`. */
export function recolectarHashes(dirOut) {
  const hashes = new Set();
  let archivos = 0;
  for (const f of htmls(dirOut)) {
    archivos++;
    for (const s of scriptsInline(readFileSync(f, 'utf8'))) hashes.add(hashSha256(s));
  }
  if (!archivos) throw new Error(`csp-hashes: no hay HTML en ${dirOut} (¿corriste npm run build?)`);
  return { archivos, scripts: [...hashes].sort() };
}

/** Sustituye el marcador de la plantilla por los hashes. */
export function renderizarCsp(plantilla, hashes) {
  const lineas = plantilla.split('\n');
  const esDirectiva = (l) => !l.trimStart().startsWith('#') && l.includes(MARCADOR);
  if (!lineas.some(esDirectiva)) throw new Error(`csp-hashes: la plantilla no tiene el marcador ${MARCADOR}`);
  const valor = hashes.join(' ');
  return lineas.map((l) => (esDirectiva(l) ? (valor ? l.replace(MARCADOR, valor) : l.replace(`${MARCADOR} `, '').replace(MARCADOR, '')) : l)).join('\n');
}

/** Hashes 'sha256-…' de script-src de una conf generada (para --unir). */
export function hashesDeConf(texto) {
  let csp;
  try {
    csp = headersDe(parsearNginx(texto)).find((h) => h.nombre === 'content-security-policy');
  } catch {
    return [];
  }
  const fuentes = csp ? (parsearCsp(csp.valor)['script-src'] ?? []) : [];
  return [...new Set(fuentes.filter((f) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(f)))].sort();
}

export function generarCspConf({ dirOut, plantilla, unirCon }) {
  const { archivos, scripts } = recolectarHashes(dirOut);
  const hashes = [...new Set([...scripts, ...(unirCon ? hashesDeConf(unirCon) : [])])].sort();
  const cuerpo = renderizarCsp(plantilla, hashes);
  const conf = `# GENERADO por scripts/csp-hashes.mjs — NO EDITAR (fuente: infra/nginx/csp.plantilla.conf).\n# ${archivos} HTML, ${hashes.length} hashes de scripts inline.\n${cuerpo}`;
  return { conf, hashes, archivos };
}

function args(argv) {
  const o = { ...RUTAS_DEFECTO, unir: null };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (k && k in o) o[k] = argv[i + 1];
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const o = args(process.argv.slice(2));
  try {
    const unirCon = o.unir && existsSync(o.unir) ? readFileSync(o.unir, 'utf8') : undefined;
    const r = generarCspConf({ dirOut: o.out, plantilla: readFileSync(o.plantilla, 'utf8'), unirCon });
    writeFileSync(o.destino, r.conf);
    const largo = headersDe(parsearNginx(r.conf)).find((h) => h.nombre === 'content-security-policy')?.valor.length ?? 0;
    if (largo > LIMITE_HEADER) console.warn(`::warning::CSP de ${largo} bytes (> ${LIMITE_HEADER}); revisa scripts inline.`);
    console.log(`csp-hashes: ${r.archivos} HTML, ${r.hashes.length} hashes${unirCon ? ' (unidos con la conf previa)' : ''} → ${o.destino} (${largo} bytes)`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
