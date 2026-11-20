#!/usr/bin/env node
/**
 * NFR-ESC-06 · Genera supabase/functions/_generated/vacantes.ts con un import por cada
 * apps/web/vacantes/*.json. Deno no puede listar apps/web en runtime y el CLI de Supabase solo
 * empaqueta lo que alcanza el grafo de imports: por eso el índice es código generado y versionado.
 *
 *   npm run generar:vacantes        (también corre en `prebuild`)
 *   node scripts/generar-indice-vacantes.mjs --verificar   (exit 1 si falta alguna vacante)
 *
 * Guardia: scripts/generar-indice-vacantes.test.ts.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR_VACANTES = 'apps/web/vacantes';
export const ARCHIVO_INDICE = 'supabase/functions/_generated/vacantes.ts';
const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugsDe(dirVacantes) {
  const slugs = readdirSync(dirVacantes).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
  for (const s of slugs) if (!RE_SLUG.test(s)) throw new Error(`nombre de vacante inválido (debe ser un slug a-z0-9-): ${s}.json`);
  return slugs;
}

/** Devuelve el contenido del índice (determinista). */
export function generarIndice({ dirVacantes, archivoIndice }) {
  const slugs = slugsDe(dirVacantes);
  const rel = relative(dirname(archivoIndice), dirVacantes).split(sep).join('/');
  const lineas = [
    '// GENERADO por scripts/generar-indice-vacantes.mjs — NO editar a mano.',
    '// Alta de una vacante: agregar apps/web/vacantes/<slug>.json y correr `npm run generar:vacantes` (corre solo en prebuild).',
    '// Las reglas operativas (agenda, mensajes, Zoho) se configuran en el panel, no aquí (NFR-ESC-06).',
    ...slugs.map((s, i) => `import v${i} from '${rel}/${s}.json' with { type: 'json' };`),
    '',
    '/** Contenido crudo de cada vacante; validar con ContenidoVacanteSchema antes de usarlo. */',
    `export const CONTENIDOS_VACANTES: readonly unknown[] = [${slugs.map((_, i) => `v${i}`).join(', ')}];`,
    `export const SLUGS_ARCHIVO = [${slugs.map((s) => `'${s}'`).join(', ')}] as const;`,
    '',
  ];
  return lineas.join('\n');
}

export function verificarIndice({ dirVacantes, archivoIndice }) {
  const actual = existsSync(archivoIndice) ? readFileSync(archivoIndice, 'utf8') : '';
  const faltantes = slugsDe(dirVacantes).filter((s) => !actual.includes(`/${s}.json'`));
  return { ok: faltantes.length === 0 && actual === generarIndice({ dirVacantes, archivoIndice }), faltantes };
}

const esCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esCli) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const opts = { dirVacantes: join(root, DIR_VACANTES), archivoIndice: join(root, ARCHIVO_INDICE) };
  if (process.argv.includes('--verificar')) {
    const r = verificarIndice(opts);
    if (!r.ok) {
      console.error(`Índice de vacantes desactualizado${r.faltantes.length ? ` (faltan: ${r.faltantes.join(', ')})` : ''}. Corre: npm run generar:vacantes`);
      process.exit(1);
    }
    console.log('Índice de vacantes al día.');
  } else {
    mkdirSync(dirname(opts.archivoIndice), { recursive: true });
    writeFileSync(opts.archivoIndice, generarIndice(opts));
    console.log(`${ARCHIVO_INDICE}: ${slugsDe(opts.dirVacantes).length} vacante(s).`);
  }
}
