/**
 * Lectura del contenido por vacante en build (server components): apps/web/vacantes/*.json validado con Zod.
 * Agregar una vacante = agregar su JSON (NFR-ESC-06). Si un JSON es inválido, el build falla.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ContenidoVacanteSchema, type ContenidoVacante } from '../../../../src/domains/captacion';

function directorio(): string {
  for (const d of [join(process.cwd(), 'apps', 'web', 'vacantes'), join(process.cwd(), 'vacantes')]) if (existsSync(d)) return d;
  throw new Error('No se encontró apps/web/vacantes');
}

export function listarVacantes(): ContenidoVacante[] {
  const dir = directorio();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const r = ContenidoVacanteSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!r.success) throw new Error(`Contenido inválido en ${f}: ${r.error.message}`);
      return r.data;
    });
}

export function obtenerVacante(slug: string): ContenidoVacante | null {
  return listarVacantes().find((v) => v.slug === slug) ?? null;
}

/** Enlaces para el menú "Vacantes Premium". */
export const menuVacantes = () => listarVacantes().map((v) => ({ slug: v.slug, etiqueta: v.menu_etiqueta }));
