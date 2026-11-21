#!/usr/bin/env node
/**
 * Servidor estático SIN dependencias para `apps/web/out` que imita a infra/nginx:
 *  - mismos headers de seguridad (lee infra/nginx/security-headers.conf y su include snippets/csp.conf =
 *    infra/nginx/csp.conf, la CSP con hashes que genera scripts/csp-hashes.mjs tras el build; si falta o no
 *    cubre los scripts inline del dir servido, la regenera en memoria con la MISMA función y avisa),
 *  - trailingSlash: /ruta → 301 /ruta/ (conserva la query), /ruta/ → /ruta/index.html,
 *  - 404 con out/404.html, archivos ocultos denegados, solo GET/HEAD,
 *  - Cache-Control como Nginx (_next/static inmutable, HTML no-cache),
 *  - gzip como Nginx (gzip on, nivel 5, mismos tipos): sin él Lighthouse simula bajar el JS sin comprimir (~3×)
 *    y el LCP medido no se parece al de producción.
 * Lo usan Playwright (webServer) y Lighthouse CI. Uso:
 *   node scripts/serve-out.mjs [--dir apps/web/out] [--port 4173] [--host 127.0.0.1]
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { generarCspConf, hashesDeConf, recolectarHashes, renderizarCsp, RUTAS_DEFECTO } from './csp-hashes.mjs';
import { headersDe, parsearNginx, resolverIncludes } from './lib/nginx-conf.mjs';

const RAIZ_REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
};

const DIR_NGINX = join(RAIZ_REPO, 'infra', 'nginx');

/** Tipos que comprime Nginx: text/html siempre + gzip_types de infra/nginx/369capitalhumano.conf. */
const GZIP_TIPOS = /^(?:text\/html|text\/plain|text\/css|application\/javascript|application\/json|image\/svg\+xml|text\/x-component|application\/manifest\+json|application\/xml)\b/;

/** ¿Se responde con gzip? (pura, probada en scripts/serve-out.test.ts) */
export function usarGzip(acceptEncoding, contentType, tamano) {
  return /\bgzip\b/i.test(acceptEncoding ?? '') && GZIP_TIPOS.test(contentType) && tamano >= 20;
}

/** Texto de snippets/csp.conf para `dirOut`: la conf generada si cubre el build; si no, regenerada en memoria. */
function cspConfPara(dirOut, cspPath) {
  const plantilla = readFileSync(RUTAS_DEFECTO.plantilla, 'utf8');
  const generada = existsSync(cspPath) ? readFileSync(cspPath, 'utf8') : null;
  if (!dirOut || !existsSync(dirOut)) return generada ?? renderizarCsp(plantilla, []);
  if (generada) {
    const cubiertos = new Set(hashesDeConf(generada));
    if (recolectarHashes(dirOut).scripts.every((h) => cubiertos.has(h))) return generada;
    console.warn(`serve-out: ${cspPath} no cubre los scripts inline de ${dirOut}; se regenera en memoria (corre scripts/csp-hashes.mjs).`);
  }
  return generarCspConf({ dirOut, plantilla }).conf;
}

/**
 * Headers de seguridad de Nginx (security-headers.conf con sus includes).
 * @param {{ confPath?: string; dirOut?: string; cspPath?: string }} [o]
 */
export function headersSeguridad(o = {}) {
  const confPath = o.confPath ?? join(DIR_NGINX, 'security-headers.conf');
  const cspPath = o.cspPath ?? RUTAS_DEFECTO.destino;
  const resolver = (ruta) => (basename(ruta) === 'csp.conf' ? cspConfPara(o.dirOut, cspPath) : readFileSync(join(DIR_NGINX, basename(ruta)), 'utf8'));
  const directivas = resolverIncludes(parsearNginx(readFileSync(confPath, 'utf8')), resolver);
  return Object.fromEntries(headersDe(directivas).map((h) => [h.nombre, h.valor]));
}

function cacheControl(ruta) {
  if (ruta.startsWith('/_next/static/')) return 'public, max-age=31536000, immutable';
  if (/\.(?:webp|avif|png|jpe?g|gif|svg|ico|mp4|webm|woff2?)$/i.test(ruta)) return 'public, max-age=604800';
  return 'no-cache';
}

/** Decide qué responder (pura, probada en scripts/serve-out.test.ts). */
export function resolverRuta(dir, metodo, urlTexto) {
  if (metodo !== 'GET' && metodo !== 'HEAD') return { estado: 403 };
  const url = new URL(urlTexto, 'http://x');
  let ruta;
  try {
    ruta = decodeURIComponent(url.pathname);
  } catch {
    return { estado: 400 };
  }
  if (ruta.includes('\0')) return { estado: 400 };
  if (/\/\.(?!well-known)/.test(ruta)) return { estado: 404, archivo: join(dir, '404.html') };
  if (/^[^.]*[^/]$/.test(ruta)) return { estado: 301, location: `${ruta}/${url.search}` };
  const absoluto = normalize(join(dir, ruta));
  if (absoluto !== dir && !absoluto.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return { estado: 404, archivo: join(dir, '404.html') };
  let archivo = absoluto;
  if (existsSync(archivo) && statSync(archivo).isDirectory()) archivo = join(archivo, 'index.html');
  if (existsSync(archivo) && statSync(archivo).isFile()) return { estado: 200, archivo, cache: cacheControl(ruta) };
  return { estado: 404, archivo: join(dir, '404.html') };
}

export function crearServidor({ dir, cspPath, headers = headersSeguridad({ dirOut: dir, cspPath }) }) {
  const raiz = resolve(dir);
  return createServer((req, res) => {
    const r = resolverRuta(raiz, req.method ?? 'GET', req.url ?? '/');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('cache-control', r.cache ?? 'no-cache');
    if (r.estado === 301) {
      res.writeHead(301, { location: r.location }).end();
      return;
    }
    if (!r.archivo || !existsSync(r.archivo)) {
      res.writeHead(r.estado, { 'content-type': 'text/plain; charset=utf-8' }).end(r.estado === 404 ? 'Not Found' : '');
      return;
    }
    const tipo = MIME[extname(r.archivo).toLowerCase()] ?? 'application/octet-stream';
    const tamano = statSync(r.archivo).size;
    const gzip = usarGzip(req.headers['accept-encoding'], tipo, tamano);
    if (GZIP_TIPOS.test(tipo)) res.setHeader('vary', 'Accept-Encoding');
    res.writeHead(r.estado, gzip ? { 'content-type': tipo, 'content-encoding': 'gzip' } : { 'content-type': tipo, 'content-length': tamano });
    if (req.method === 'HEAD') res.end();
    else if (gzip) createReadStream(r.archivo).pipe(createGzip({ level: 5 })).pipe(res);
    else createReadStream(r.archivo).pipe(res);
  });
}

function args(argv) {
  const out = { dir: 'apps/web/out', port: Number(process.env.PORT ?? 4173), host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (k === 'dir') out.dir = argv[i + 1];
    else if (k === 'port') out.port = Number(argv[i + 1]);
    else if (k === 'host') out.host = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, port, host } = args(process.argv.slice(2));
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`serve-out: ${dir}/index.html no existe; corre "npm run build" primero.`);
    process.exit(2);
  }
  crearServidor({ dir }).listen(port, host, () => console.log(`serve-out: escuchando en http://${host}:${port}/ (${dir})`));
}
