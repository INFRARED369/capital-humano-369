/**
 * NFR-ESC-05 · Reglas cacheadas por versión. Las versiones de config.vacantes_reglas son
 * inmutables (trigger), así que (vacante, versión) → ReglasAgenda validadas se puede cachear
 * sin invalidación; solo se consulta el número de versión vigente (PK, barato).
 */
import { PLANTILLA_AGENDA_DEFECTO, extraerReglasAgenda, type ReglasAgenda } from '../domain/reglas.ts';
import type { CitasRepo } from './puertos.ts';

const MAX_ENTRADAS = 1000;
const cache = new Map<string, ReglasAgenda>();

export interface ReglasResueltas { version: number; agenda: ReglasAgenda }

export async function reglasDeVacante(repo: Pick<CitasRepo, 'reglasVigentes'>, vacanteId: string): Promise<ReglasResueltas> {
  const fila = await repo.reglasVigentes(vacanteId);
  if (!fila) return { version: 0, agenda: PLANTILLA_AGENDA_DEFECTO };
  const llave = `${vacanteId}:${fila.version}`;
  const enCache = cache.get(llave);
  if (enCache) return { version: fila.version, agenda: enCache };
  const r = extraerReglasAgenda(fila);
  if (!r.ok) throw new Error(`REGLAS_INVALIDAS vacante=${vacanteId} version=${fila.version}`);
  if (cache.size >= MAX_ENTRADAS) cache.delete(cache.keys().next().value as string);
  cache.set(llave, r.value.agenda);
  return r.value;
}

export function limpiarCacheReglas(): void {
  cache.clear();
}

export const tamanoCacheReglas = (): number => cache.size;
