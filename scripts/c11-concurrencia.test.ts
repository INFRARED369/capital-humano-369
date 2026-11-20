/**
 * C11 real (Postgres con N conexiones vía psql en paralelo). Se omite si no hay SUPABASE_DB_URL_LOCAL o psql:
 *   SUPABASE_DB_URL_LOCAL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run scripts/c11-concurrencia.test.ts
 * En CI (job pgtap) corre con C11_OBLIGATORIO=1: si faltan la URL o psql, FALLA en lugar de omitirse (sin verde falso).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const URL_DB = process.env.SUPABASE_DB_URL_LOCAL;
const hayPsql = spawnSync('psql', ['--version']).status === 0;
const SCRIPT = fileURLToPath(new URL('./c11-concurrencia.mjs', import.meta.url));

describe.runIf(process.env.C11_OBLIGATORIO === '1')('C11 · prerrequisitos en CI', () => {
  it('hay SUPABASE_DB_URL_LOCAL y psql', () => {
    expect(URL_DB, 'SUPABASE_DB_URL_LOCAL').toBeTruthy();
    expect(hayPsql, 'psql en el PATH').toBe(true);
  });
});

describe.skipIf(!URL_DB || !hayPsql)('C11 · concurrencia real en Postgres', () => {
  it('último lugar: 1 éxito de 20; cupo diario 10 con 50 concurrentes; retencion_diaria: una omitida', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, SUPABASE_DB_URL_LOCAL: URL_DB }, encoding: 'utf8', timeout: 120_000 });
    const r = JSON.parse(out);
    expect(r.A_ultimo_lugar.resultados.OK).toBe(1);
    expect(r.A_ultimo_lugar.activas).toBe(10);
    expect(r.B_cupo_diario.resultados.OK).toBe(10);
    expect(r.B_cupo_diario.activas_por_dia).toBe('10');
    expect(r.C_retencion_diaria.omitidas.true).toBe(1);
    expect(r.ok).toBe(true);
  }, 150_000);
});
