/**
 * NFR-SEG-07 / NFR-ESC-02 / E2E-14 (local): la configuración de Nginx sirve `out/` con
 * los headers de seguridad en TODAS las ubicaciones y cache correcto para `_next/static`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bloques, headersDe, parsearNginx, resolverIncludes, type Directiva } from '../../scripts/lib/nginx-conf.mjs';
import { renderizarCsp } from '../../scripts/csp-hashes.mjs';
import { verificarHeaders } from './headers-esperados';

const DIR = import.meta.dirname;
const leer = (f: string) => readFileSync(join(DIR, f), 'utf8');
// Las rutas de include en el servidor (/etc/nginx/snippets/…) se mapean a infra/nginx/<basename>.
// csp.conf se genera en cada build: aquí se renderiza la plantilla con un hash de ejemplo.
const HASH_EJEMPLO = "'sha256-RFWPLDbv2BY+rCkDzsE+0fr8ylGr2R2faWMhq4lfEQc='";
const resolver = (ruta: string) => (basename(ruta) === 'csp.conf' ? renderizarCsp(leer('csp.plantilla.conf'), [HASH_EJEMPLO]) : leer(basename(ruta)));
const seguridad = () => resolverIncludes(parsearNginx(leer('security-headers.conf')), resolver);

const sitio = parsearNginx(leer('369capitalhumano.conf'));
const sitioResuelto = resolverIncludes(sitio, resolver);
const servidores = bloques(sitio, 'server');
const https = servidores.find((s) => s.bloque!.some((d) => d.nombre === 'listen' && d.args.includes('ssl')))!;
const httpsResuelto = bloques(sitioResuelto, 'server').find((s) => s.bloque!.some((d) => d.nombre === 'listen' && d.args.includes('ssl')))!;
const directiva = (bl: Directiva[], n: string) => bl.find((d) => d.nombre === n);
const comoMapa = (bl: Directiva[]) => Object.fromEntries(headersDe(bl).map((h) => [h.nombre, h.valor]));

describe('parser de Nginx', () => {
  it('parsea bloques, comillas, comentarios e includes', () => {
    const ast = parsearNginx(`# c\nserver { listen 443 ssl; add_header X-A "a; b" always; location / { include x.conf; } }`);
    expect(ast[0]).toMatchObject({ nombre: 'server', bloque: [{ nombre: 'listen', args: ['443', 'ssl'] }, { nombre: 'add_header', args: ['X-A', 'a; b', 'always'] }, { nombre: 'location' }] });
    const r = resolverIncludes(ast, () => 'add_header X-B b;');
    expect(headersDe(bloques(r, 'location')[0]!.bloque!)).toEqual([{ nombre: 'x-b', valor: 'b', always: false }]);
  });
  it('rechaza configuración mal formada', () => {
    expect(() => parsearNginx('server { listen 80;')).toThrow();
    expect(() => parsearNginx('add_header "x;')).toThrow();
    expect(() => parsearNginx('}')).toThrow();
  });
});

describe('security-headers.conf', () => {
  const hs = headersDe(seguridad());
  it("incluye snippets/csp.conf (generada por build) y la CSP no tiene 'unsafe-inline' en script-src", () => {
    expect(parsearNginx(leer('security-headers.conf')).some((d) => d.nombre === 'include' && d.args[0] === 'snippets/csp.conf')).toBe(true);
    const csp = hs.find((h) => h.nombre === 'content-security-policy')!.valor;
    expect(csp).toMatch(/script-src 'self' 'sha256-/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
  it('cumple la política de headers (CSP, HSTS, XFO, Referrer, nosniff, Permissions)', () => {
    expect(verificarHeaders(Object.fromEntries(hs.map((h) => [h.nombre, h.valor])))).toEqual([]);
  });
  it('todos usan "always" (también en 404/5xx)', () => {
    expect(hs.filter((h) => !h.always).map((h) => h.nombre)).toEqual([]);
  });
  it('la CSP permite Clarity, Meta Pixel, GTM/GA4, Turnstile, Supabase y Stape', () => {
    const csp = hs.find((h) => h.nombre === 'content-security-policy')!.valor;
    for (const host of ['clarity.ms', 'connect.facebook.net', 'googletagmanager.com', 'google-analytics.com', 'challenges.cloudflare.com', 'supabase.co', 'stape.io'])
      expect(csp).toContain(host);
  });
});

describe('verificarHeaders detecta incumplimientos', () => {
  const base = Object.fromEntries(headersDe(seguridad()).map((h) => [h.nombre, h.valor]));
  it.each([
    ['sin CSP', { 'content-security-policy': undefined }, /falta content-security-policy/],
    ['XFO SAMEORIGIN', { 'x-frame-options': 'SAMEORIGIN' }, /DENY/],
    ['HSTS corto', { 'strict-transport-security': 'max-age=300' }, /max-age/],
    ['unsafe-eval', { 'content-security-policy': `${base['content-security-policy']}; script-src 'self' 'unsafe-eval'` }, /unsafe-eval|sin https/],
    ['unsafe-inline en script-src', { 'content-security-policy': (base['content-security-policy'] ?? '').replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") }, /script-src no debe incluir 'unsafe-inline'/],
    ['Server con versión', { server: 'nginx/1.24.0' }, /versión/],
    ['Referrer laxo', { 'referrer-policy': 'unsafe-url' }, /Referrer/],
  ])('%s', (_n, cambio, re) => {
    expect(verificarHeaders({ ...base, ...cambio }).join('\n')).toMatch(re);
  });
  it('HSTS es opcional cuando no se exige (http local)', () => {
    expect(verificarHeaders({ ...base, 'strict-transport-security': undefined }, { exigirHsts: false })).toEqual([]);
  });
});

describe('server block de out/ (NFR-ESC-02)', () => {
  it('hay un server HTTP que redirige a HTTPS y uno HTTPS con http2', () => {
    const http = servidores.find((s) => s !== https)!;
    expect(directiva(http.bloque!, 'listen')!.args).toContain('80');
    expect(JSON.stringify(http.bloque)).toMatch(/return.*301.*https:\/\/\$host\$request_uri/);
    expect(https).toBeDefined();
    expect(JSON.stringify(https.bloque)).toMatch(/"http2","on"|"http2"/);
  });

  it('el server HTTPS incluye security-headers.conf a nivel server y oculta la versión', () => {
    expect(https.bloque!.some((d) => d.nombre === 'include' && d.args[0]!.endsWith('security-headers.conf'))).toBe(true);
    expect(directiva(https.bloque!, 'server_tokens')!.args).toEqual(['off']);
    expect(verificarHeaders(comoMapa(httpsResuelto.bloque!))).toEqual([]);
  });

  it('root apunta al export estático y try_files es compatible con trailingSlash', () => {
    expect(directiva(https.bloque!, 'root')!.args[0]).toMatch(/\/out\/?$|\/current\/?$|\/html\/?$/);
    expect(directiva(https.bloque!, 'index')!.args).toEqual(['index.html']);
    const raiz = bloques(https.bloque!, 'location').find((l) => l.args.join(' ') === '/')!;
    expect(directiva(raiz.bloque!, 'try_files')!.args).toEqual(['$uri', '$uri/', '=404']);
    // trailingSlash: /vacantes/agente-smart → 301 /vacantes/agente-smart/ (relativo, conserva la query de las campañas)
    const barra = bloques(https.bloque!, 'location').find((l) => l.args[0] === '~' && l.args[1] === '^([^.]*[^/])$')!;
    expect(directiva(barra.bloque!, 'return')!.args).toEqual(['301', '$1/$is_args$args']);
    expect(directiva(https.bloque!, 'error_page')!.args).toEqual(['404', '/404.html']);
    expect(directiva(https.bloque!, 'absolute_redirect')!.args).toEqual(['off']);
  });

  it('heredabilidad: toda location con add_header vuelve a incluir los headers de seguridad', () => {
    for (const loc of bloques(httpsResuelto.bloque!, 'location')) {
      if (headersDe(loc.bloque!).length === 0) continue; // hereda los del server
      expect(verificarHeaders(comoMapa(loc.bloque!)), `location ${loc.args.join(' ')}`).toEqual([]);
    }
  });

  it('_next/static es inmutable por 1 año; el HTML no se cachea', () => {
    const estaticos = bloques(httpsResuelto.bloque!, 'location').find((l) => l.args.join(' ').includes('/_next/static/'))!;
    expect(comoMapa(estaticos.bloque!)['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(comoMapa(httpsResuelto.bloque!)['cache-control']).toMatch(/no-cache/);
  });

  it('niega archivos ocultos (salvo .well-known) y métodos distintos de GET/HEAD', () => {
    const txt = JSON.stringify(https.bloque);
    expect(txt).toMatch(/"location","args":\["~","\/\\\\.\(\?!well-known\)"\]/);
    expect(txt).toMatch(/limit_except.*GET.*HEAD/);
  });
});
