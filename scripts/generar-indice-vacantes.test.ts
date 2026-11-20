/**
 * NFR-ESC-06 · Alta de una vacante sin código: el índice `supabase/functions/_generated/vacantes.ts`
 * lo genera `scripts/generar-indice-vacantes.mjs` a partir de `apps/web/vacantes/*.json`.
 * Guardia: falla si algún JSON no está en el índice (o el índice quedó desactualizado).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { ARCHIVO_INDICE, DIR_VACANTES, generarIndice, verificarIndice } from './generar-indice-vacantes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'indice-vacantes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('generarIndice', () => {
  it('importa cada JSON (orden estable, con atributo json y extensión explícita) y exporta la lista', () => {
    const dir = join(tmp, 'vacantes');
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 'zeta-ventas.json'), '{}');
    writeFileSync(join(dir, 'agente-smart.json'), '{}');
    writeFileSync(join(dir, 'LEEME.md'), 'no es vacante');
    const out = generarIndice({ dirVacantes: dir, archivoIndice: join(tmp, 'out', '_generated', 'vacantes.ts') });
    expect(out).toContain('GENERADO');
    expect(out).toMatch(/import v0 from '\.\.\/\.\.\/vacantes\/agente-smart\.json' with \{ type: 'json' \};/);
    expect(out).toMatch(/import v1 from '\.\.\/\.\.\/vacantes\/zeta-ventas\.json' with \{ type: 'json' \};/);
    expect(out).toContain('export const CONTENIDOS_VACANTES: readonly unknown[] = [v0, v1];');
    expect(out).toContain("export const SLUGS_ARCHIVO = ['agente-smart', 'zeta-ventas'] as const;");
    expect(out).not.toContain('LEEME');
  });

  it('rechaza nombres de archivo que no son slugs (evita inyección en el código generado)', () => {
    const dir = join(tmp, 'malos');
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, "x'; process.exit(1); '.json"), '{}');
    expect(() => generarIndice({ dirVacantes: dir, archivoIndice: join(tmp, 'i.ts') })).toThrow(/slug/);
  });

  it('verificarIndice detecta un índice desactualizado', () => {
    const dir = join(tmp, 'v2');
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 'a.json'), '{}');
    const indice = join(tmp, 'v2-indice.ts');
    writeFileSync(indice, generarIndice({ dirVacantes: dir, archivoIndice: indice }));
    expect(verificarIndice({ dirVacantes: dir, archivoIndice: indice })).toEqual({ ok: true, faltantes: [] });
    writeFileSync(join(dir, 'b.json'), '{}');
    expect(verificarIndice({ dirVacantes: dir, archivoIndice: indice })).toEqual({ ok: false, faltantes: ['b'] });
  });
});

describe('guardia del repositorio', () => {
  it('todo apps/web/vacantes/*.json está en supabase/functions/_generated/vacantes.ts y el índice está al día', () => {
    const jsons = readdirSync(join(ROOT, DIR_VACANTES)).filter((f) => f.endsWith('.json'));
    expect(jsons.length).toBeGreaterThan(0);
    const indice = join(ROOT, ARCHIVO_INDICE);
    expect(existsSync(indice), `falta ${ARCHIVO_INDICE}: corre npm run generar:vacantes`).toBe(true);
    const actual = readFileSync(indice, 'utf8');
    for (const f of jsons) expect(actual, `${f} no está en el índice: corre npm run generar:vacantes`).toContain(`/vacantes/${f}'`);
    expect(actual).toBe(generarIndice({ dirVacantes: join(ROOT, DIR_VACANTES), archivoIndice: indice }));
  });

  it('postular usa el índice generado (sin imports a mano de JSON de vacantes)', () => {
    const src = readFileSync(join(ROOT, 'supabase/functions/postular/index.ts'), 'utf8');
    expect(src).toContain("from '../_generated/vacantes.ts'");
    expect(src).not.toMatch(/apps\/web\/vacantes\/[^'"]+\.json/);
  });

  it('package.json engancha el generador en prebuild y en generar:vacantes', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['generar:vacantes']).toBe('node scripts/generar-indice-vacantes.mjs');
    expect(pkg.scripts.prebuild).toContain('generar:vacantes');
  });
});
