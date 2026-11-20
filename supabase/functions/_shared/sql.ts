/**
 * Adaptador de postgres.js (`npm:postgres`) al puerto `SqlClient` de src/shared/sql.ts.
 * La creación real (con SUPABASE_DB_URL) vive en ./index.ts (solo Deno); aquí la parte pura.
 */
import type { SqlClient } from '@shared/sql.ts';

/** Subconjunto estructural de postgres.js que usamos (Sql y TransactionSql). */
export interface PostgresLike {
  unsafe(query: string, params?: unknown[]): PromiseLike<readonly unknown[]>;
  begin?<T>(fn: (tx: PostgresLike) => Promise<T>): PromiseLike<T>;
  savepoint?<T>(fn: (sp: PostgresLike) => Promise<T>): PromiseLike<T>;
}

const esObjetoPlano = (v: unknown): v is object =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !(v instanceof Uint8Array) && !Array.isArray(v);

/**
 * postgres.js no infiere jsonb para objetos en `unsafe`: se serializan a JSON (las consultas
 * usan `$n::jsonb`). Los arrays de primitivos pasan como arrays de Postgres. `undefined` → null.
 */
export function normalizarParametros(params: readonly unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (esObjetoPlano(p)) return JSON.stringify(p);
    if (Array.isArray(p) && p.some(esObjetoPlano)) return JSON.stringify(p);
    return p;
  });
}

/**
 * Tipos json/jsonb para postgres.js (opción `types`). Su serializador por defecto hace JSON.stringify de
 * lo que recibe; como los repositorios ya mandan JSON serializado (`JSON.stringify(x)` + `$n::jsonb`, igual
 * que en PGlite), una cadena se codificaba DOS veces (jsonb escalar de texto → `p ->> 'event_id'` = null).
 * Hallado al correr tracking-ingest en el edge runtime real (integración, ciclo 3).
 */
const serializarJson = (x: unknown): string => (typeof x === 'string' ? x : JSON.stringify(x));
const parsearJson = (x: string): unknown => JSON.parse(x);
export const TIPOS_JSON_POSTGRES = {
  json: { to: 114, from: [114, 3802], serialize: serializarJson, parse: parsearJson },
  jsonb: { to: 3802, from: [3802], serialize: serializarJson, parse: parsearJson },
} as const;

export function sqlClientDesdePostgres(pg: PostgresLike, enTransaccion = false): SqlClient {
  return {
    async query<T>(q: string, params: unknown[] = []) {
      const filas = await pg.unsafe(q, normalizarParametros(params));
      return { rows: [...filas] as T[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const abrir = enTransaccion ? pg.savepoint : pg.begin;
      if (!abrir) throw new Error(enTransaccion ? 'savepoint no disponible' : 'begin no disponible');
      return abrir.call(pg, (tx: PostgresLike) => fn(sqlClientDesdePostgres(tx, true))) as Promise<T>;
    },
  };
}
