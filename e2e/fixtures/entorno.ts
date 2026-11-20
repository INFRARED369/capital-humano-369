/** Contexto de ejecución de los E2E: local (out/ servido) o staging (STAGING_URL). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const STAGING = !!process.env.STAGING_URL;
/** En CI (o E2E_ESTRICTO=1) las rutas críticas DEBEN existir: un deploy con rsync --delete las borraría. */
export const ESTRICTO = !!process.env.CI || process.env.E2E_ESTRICTO === '1' || STAGING;
export const DIR_OUT = join(import.meta.dirname, '..', '..', 'apps', 'web', 'out');

/** ¿La ruta está en el export? (en staging se asume que sí). */
export function rutaExportada(ruta: string): boolean {
  if (STAGING) return true;
  const rel = ruta.replace(/^\//, '');
  return existsSync(join(DIR_OUT, rel, 'index.html')) || existsSync(join(DIR_OUT, rel));
}

/** Rutas que no se pueden romper (URLs de campañas: CAP-01, E2E-12). */
export const RUTAS_CRITICAS = ['/', '/vacantes/agente-smart/'] as const;
