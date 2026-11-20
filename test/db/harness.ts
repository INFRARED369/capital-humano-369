/**
 * Arnés de BD para pruebas (*.db.test.ts y *.int.test.ts).
 * Usa PGlite (Postgres 17 en proceso) en lugar de Supabase local + pgTAP porque
 * Docker no está disponible en este entorno. Aplica supabase/tests/bootstrap.sql
 * y luego TODAS las migraciones de supabase/migrations en orden.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlClient } from '../../src/shared/sql.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRACIONES = join(ROOT, 'supabase', 'migrations');

export type Rol = 'anon' | 'authenticated' | 'service_role';

export interface TestDb {
  pg: PGlite;
  /** Cliente SQL como superusuario (equivale a migraciones / postgres). */
  sql: SqlClient;
  /** Ejecuta fn con el rol y claims de JWT indicados; luego restaura. */
  como<T>(rol: Rol, claims: Record<string, unknown> | null, fn: (sql: SqlClient) => Promise<T>): Promise<T>;
  /** Atajo: usuario autenticado con ese sub. */
  comoUsuario<T>(userId: string, fn: (sql: SqlClient) => Promise<T>): Promise<T>;
  /** Cliente SQL como service_role (lo que usan las edge functions). */
  servicio: SqlClient;
  close(): Promise<void>;
}

export function sqlClientDe(pg: Pick<PGlite, 'query' | 'transaction'>): SqlClient {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const r = await pg.query<T>(sql, params as never[]);
      return { rows: r.rows };
    },
    transaction: <T>(fn: (tx: SqlClient) => Promise<T>) =>
      pg.transaction(async (tx) =>
        fn({
          query: async <U>(sql: string, params: unknown[] = []) => ({ rows: (await tx.query<U>(sql, params as never[])).rows }),
          transaction: (inner) => inner(sqlClientDe(tx as unknown as PGlite)),
        }),
      ) as Promise<T>,
  };
}

export function archivosMigracion(): string[] {
  return readdirSync(MIGRACIONES).filter((f) => f.endsWith('.sql')).sort();
}

let plantilla: Promise<Blob> | null = null;

async function crearPlantilla(): Promise<Blob> {
  const pg = new PGlite();
  await pg.exec(readFileSync(join(ROOT, 'supabase', 'tests', 'bootstrap.sql'), 'utf8'));
  for (const f of archivosMigracion()) {
    try {
      await pg.exec(readFileSync(join(MIGRACIONES, f), 'utf8'));
    } catch (e) {
      throw new Error(`Falló la migración ${f}: ${(e as Error).message}`, { cause: e });
    }
  }
  const dump = await pg.dumpDataDir('none');
  await pg.close();
  return dump;
}

/** Crea una BD nueva y aislada con todas las migraciones (clonada de una plantilla en memoria). */
export async function crearTestDb(): Promise<TestDb> {
  plantilla ??= crearPlantilla();
  const pg = new PGlite({ loadDataDir: await plantilla });
  await pg.waitReady;
  const sql = sqlClientDe(pg);

  const como: TestDb['como'] = async (rol, claims, fn) => {
    await pg.exec(`select set_config('request.jwt.claims', ${claims ? `'${JSON.stringify(claims).replace(/'/g, "''")}'` : "''"}, false); set role ${rol};`);
    try {
      return await fn(sql);
    } finally {
      await pg.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
    }
  };

  const servicio: SqlClient = {
    query: (q, p) => como('service_role', { role: 'service_role' }, (s) => s.query(q, p)),
    transaction: (fn) => como('service_role', { role: 'service_role' }, (s) => s.transaction(fn)),
  };

  return {
    pg,
    sql,
    como,
    comoUsuario: (userId, fn) => como('authenticated', { sub: userId, role: 'authenticated' }, fn),
    servicio,
    close: () => pg.close(),
  };
}
