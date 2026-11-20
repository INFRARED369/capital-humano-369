/** NFR-SEG-07 · CSP sin 'unsafe-inline' en script-src: hashes sha256 de los <script> inline del export. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsearCsp, headersDe, parsearNginx } from './lib/nginx-conf.mjs';
import { generarCspConf, hashesDeConf, hashSha256, MARCADOR, recolectarHashes, renderizarCsp, scriptsInline } from './csp-hashes.mjs';

const RAIZ = join(import.meta.dirname, '..');
const PLANTILLA = readFileSync(join(RAIZ, 'infra', 'nginx', 'csp.plantilla.conf'), 'utf8');
const sha = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

const HTML_A = `<!DOCTYPE html><html><head><script src="/_next/static/chunks/a.js" async=""></script>
<script id="_R_">(self.__next_f=self.__next_f||[]).push([0])</script></head>
<body><script>self.__next_f.push([1,"ñ \\u003c/script\\u003e"])</script>
<script type="application/ld+json">{"@type":"JobPosting"}</script>
<SCRIPT type="text/javascript">alert(1)</SCRIPT><script></script></body></html>`;
const HTML_B = `<html><body><script>(self.__next_f=self.__next_f||[]).push([0])</script><script>otro()</script></body></html>`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'csp-hashes-'));
  mkdirSync(join(dir, 'vacantes', 'agente-smart'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), HTML_A);
  writeFileSync(join(dir, 'vacantes', 'agente-smart', 'index.html'), HTML_B);
  writeFileSync(join(dir, 'no-html.js'), '<script>ignorar()</script>');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scriptsInline', () => {
  it('extrae solo scripts ejecutables inline (sin src, sin bloques de datos, no vacíos), texto exacto', () => {
    expect(scriptsInline(HTML_A)).toEqual(['(self.__next_f=self.__next_f||[]).push([0])', 'self.__next_f.push([1,"ñ \\u003c/script\\u003e"])', 'alert(1)']);
  });
  it('hashSha256 usa UTF-8 y el formato de CSP', () => {
    expect(hashSha256('alert(1)')).toBe(sha('alert(1)'));
    expect(hashSha256('ñ')).toBe(sha('ñ'));
  });
});

describe('recolectarHashes', () => {
  it('recorre out/**/*.html y devuelve hashes únicos y ordenados (estables entre corridas)', () => {
    const r = recolectarHashes(dir);
    expect(r.archivos).toBe(2);
    expect(r.scripts).toEqual([...new Set([sha('(self.__next_f=self.__next_f||[]).push([0])'), sha('self.__next_f.push([1,"ñ \\u003c/script\\u003e"])'), sha('alert(1)'), sha('otro()')])].sort());
    expect(recolectarHashes(dir)).toEqual(r);
  });
  it('falla si el directorio no tiene HTML (build ausente)', () => {
    const vacio = mkdtempSync(join(tmpdir(), 'csp-vacio-'));
    expect(() => recolectarHashes(vacio)).toThrow(/no hay HTML/);
    rmSync(vacio, { recursive: true });
  });
});

describe('plantilla y conf generada', () => {
  it("la plantilla no tiene 'unsafe-inline' en script-src y trae el marcador", () => {
    const valor = headersDe(parsearNginx(PLANTILLA))[0]!.valor;
    expect(parsearCsp(valor)['script-src']).not.toContain("'unsafe-inline'");
    expect(parsearCsp(valor)['script-src']).toContain(MARCADOR);
  });
  it('renderizarCsp sustituye el marcador por los hashes; sin hashes no deja el marcador', () => {
    const conf = renderizarCsp(PLANTILLA, ["'sha256-AAA='", "'sha256-BBB='"]);
    const csp = parsearCsp(headersDe(parsearNginx(conf))[0]!.valor);
    expect(csp['script-src']).toEqual(expect.arrayContaining(["'self'", "'sha256-AAA='", "'sha256-BBB='", 'https://connect.facebook.net']));
    expect(csp['script-src']).not.toContain("'unsafe-inline'");
    expect(conf).not.toContain(MARCADOR);
    expect(renderizarCsp(PLANTILLA, [])).not.toContain(MARCADOR);
    expect(() => renderizarCsp('add_header X "y" always;', [])).toThrow(/marcador/);
  });
  it('hashesDeConf lee los hashes de una conf previa (deploy sin ventana rota: unión vieja + nueva)', () => {
    const previa = renderizarCsp(PLANTILLA, ["'sha256-VIEJO='"]);
    expect(hashesDeConf(previa)).toEqual(["'sha256-VIEJO='"]);
    const unida = generarCspConf({ dirOut: dir, plantilla: PLANTILLA, unirCon: previa });
    expect(hashesDeConf(unida.conf)).toEqual([...new Set([...recolectarHashes(dir).scripts, "'sha256-VIEJO='"])].sort());
    expect(hashesDeConf('basura')).toEqual([]);
  });
  it('generarCspConf: conf válida para Nginx con encabezado de "generado" y conteos', () => {
    const r = generarCspConf({ dirOut: dir, plantilla: PLANTILLA });
    expect(r.hashes).toHaveLength(4);
    expect(r.conf).toMatch(/^# GENERADO por scripts\/csp-hashes\.mjs/);
    const [h] = headersDe(parsearNginx(r.conf));
    expect(h).toMatchObject({ nombre: 'content-security-policy', always: true });
  });
});
