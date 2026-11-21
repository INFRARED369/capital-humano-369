/** serve-out imita a Nginx (trailingSlash, 404, dotfiles, métodos, cache y headers). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generarCspConf, hashSha256 } from './csp-hashes.mjs';
import { crearServidor, headersSeguridad, resolverRuta, usarGzip } from './serve-out.mjs';
import { readFileSync } from 'node:fs';

let dir: string;
let srv: Server;
let base: string;
let sinConf: string;
const INLINE = '(self.__next_f=self.__next_f||[]).push([0])';
const PLANTILLA = readFileSync(join(import.meta.dirname, '..', 'infra', 'nginx', 'csp.plantilla.conf'), 'utf8');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'serve-out-'));
  mkdirSync(join(dir, 'vacantes', 'agente-smart'), { recursive: true });
  mkdirSync(join(dir, '_next', 'static', 'chunks'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), `<h1>portada</h1><script>${INLINE}</script>`);
  sinConf = join(dir, '..', `no-existe-${Date.now()}.conf`);
  writeFileSync(join(dir, '404.html'), '<h1>404</h1>');
  writeFileSync(join(dir, 'vacantes', 'agente-smart', 'index.html'), '<h1>agente</h1>');
  writeFileSync(join(dir, '_next', 'static', 'chunks', 'a.js'), 'x');
  writeFileSync(join(dir, '.env'), 'SECRETO=1');
  srv = crearServidor({ dir, cspPath: sinConf });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('usarGzip (como Nginx: gzip on + gzip_types)', () => {
  it('comprime HTML/JS/CSS/JSON si el cliente acepta gzip; no binarios, ni sin Accept-Encoding, ni < 20 B', () => {
    expect(usarGzip('gzip, deflate, br', 'application/javascript; charset=utf-8', 5000)).toBe(true);
    expect(usarGzip('gzip', 'text/html; charset=utf-8', 5000)).toBe(true);
    expect(usarGzip('gzip', 'text/css; charset=utf-8', 5000)).toBe(true);
    expect(usarGzip('br', 'application/javascript; charset=utf-8', 5000)).toBe(false);
    expect(usarGzip(undefined, 'text/html; charset=utf-8', 5000)).toBe(false);
    expect(usarGzip('gzip', 'image/webp', 5000)).toBe(false);
    expect(usarGzip('gzip', 'font/woff2', 5000)).toBe(false);
    expect(usarGzip('gzip', 'text/html; charset=utf-8', 10)).toBe(false);
  });
});

describe('resolverRuta', () => {
  it.each([
    ['GET', '/', 200],
    ['GET', '/vacantes/agente-smart/', 200],
    ['GET', '/vacantes/agente-smart', 301],
    ['GET', '/no-existe/', 404],
    ['GET', '/.env', 404],
    ['GET', '/..%2f..%2fetc%2fpasswd', 404],
    ['GET', '/_next/..%2f..%2f..%2fpackage.json', 404],
    ['GET', '/%E0%A4%A', 400],
    ['POST', '/', 403],
  ])('%s %s → %i', (m, u, estado) => {
    expect(resolverRuta(dir, m, u).estado).toBe(estado);
  });
  it('el 301 conserva la query (UTM de campañas)', () => {
    expect(resolverRuta(dir, 'GET', '/vacantes/agente-smart?utm_source=meta').location).toBe('/vacantes/agente-smart/?utm_source=meta');
  });
});

describe('servidor HTTP', () => {
  it('sirve HTML con headers de seguridad y no-cache', async () => {
    const r = await fetch(`${base}/vacantes/agente-smart/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('agente');
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    for (const [k, v] of Object.entries(headersSeguridad({ dirOut: dir, cspPath: sinConf }))) expect(r.headers.get(k)).toBe(v);
  });
  it('_next/static inmutable; 404 con su página y headers', async () => {
    expect((await fetch(`${base}/_next/static/chunks/a.js`)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const r = await fetch(`${base}/nada/`);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('404');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });
  it('redirección relativa sin seguirla', async () => {
    const r = await fetch(`${base}/vacantes/agente-smart`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/vacantes/agente-smart/');
  });
});

describe('CSP por build (misma que Nginx: snippets/csp.conf)', () => {
  const csp = (h: Record<string, string>) => h['content-security-policy'] ?? '';
  it("sin csp.conf: la genera en memoria desde el dir servido (hash del script inline, sin 'unsafe-inline')", () => {
    const v = csp(headersSeguridad({ dirOut: dir, cspPath: sinConf }));
    expect(v).toContain(hashSha256(INLINE));
    expect(v).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
  it('con csp.conf al día: usa EXACTAMENTE la conf generada (p. ej. con hashes unidos del deploy anterior)', () => {
    const ruta = join(dir, '..', `csp-${Date.now()}.conf`);
    const previa = generarCspConf({ dirOut: dir, plantilla: PLANTILLA }).conf.replace(hashSha256(INLINE), `${hashSha256(INLINE)} 'sha256-VIEJO='`);
    writeFileSync(ruta, previa);
    expect(csp(headersSeguridad({ dirOut: dir, cspPath: ruta }))).toContain("'sha256-VIEJO='");
    rmSync(ruta);
  });
  it('con csp.conf vieja (no cubre el build actual): la regenera desde el dir y no rompe la página', () => {
    const ruta = join(dir, '..', `csp-vieja-${Date.now()}.conf`);
    writeFileSync(ruta, generarCspConf({ dirOut: dir, plantilla: PLANTILLA }).conf.replace(hashSha256(INLINE), "'sha256-VIEJO='"));
    const v = csp(headersSeguridad({ dirOut: dir, cspPath: ruta }));
    expect(v).toContain(hashSha256(INLINE));
    expect(v).not.toContain("'sha256-VIEJO='");
    rmSync(ruta);
  });
  it('el servidor responde con esa CSP', async () => {
    expect((await fetch(`${base}/`)).headers.get('content-security-policy')).toContain(hashSha256(INLINE));
  });
});
