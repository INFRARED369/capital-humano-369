/**
 * Guardia (integración): todo import relativo o @shared/@domains en src/ y supabase/functions/ lleva extensión
 * explícita. El CLI de Supabase (functions serve/deploy) recorre el grafo de imports para montar/empaquetar
 * los archivos y NO resuelve imports sin extensión ("sloppy imports"): sin esto, las funciones no arrancan.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

describe('imports compatibles con Deno / CLI de Supabase', () => {
  it('src/ y supabase/functions/ no tienen imports sin extensión', () => {
    const malos: string[] = [];
    for (const f of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'supabase/functions'))].filter((x) => /\.tsx?$/.test(x))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]((?:\.{1,2}\/|@shared\/|@domains\/)[^'"]*)['"]/g)) {
        if (!/\.(ts|tsx|json)$/.test(m[1]!)) malos.push(`${f.slice(ROOT.length)}: ${m[1]}`);
      }
    }
    expect(malos).toEqual([]);
  });
});
