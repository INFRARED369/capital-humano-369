/**
 * Cableado Deno de las utilidades compartidas (dueño: plataforma).
 * Este archivo solo corre en el edge runtime (usa Deno y npm:postgres); por eso, como todo
 * `supabase/functions/**\/index.ts`, está excluido del typecheck de Node. La lógica vive en
 * módulos puros probados en Node: env.ts, servir.ts, sql.ts, rate-limit.ts.
 *
 * Uso típico en supabase/functions/<fn>/index.ts:
 *
 *   import { entornoDeno, servir, sqlDeno } from '../_shared/index.ts';
 *   import { crearHandlerPostular } from '@domains/captacion/index.ts';
 *   const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'ALLOWED_ORIGIN']); // falla al arrancar
 *   const sql = sqlDeno(env.SUPABASE_DB_URL);
 *   const handler = crearHandlerPostular({ sql, ... });
 *   Deno.serve(servir((req, ctx) => handler(req, { log: ctx.log, ip: ctx.ip }), { funcion: 'postular', origenes: env.ALLOWED_ORIGIN }));
 */
import postgres from 'postgres';
import type { SqlClient } from '@shared/sql.ts';
import { leerEntorno, type ClaveEntorno, type Entorno } from './env.ts';
import { sqlClientDesdePostgres, TIPOS_JSON_POSTGRES, type PostgresLike } from './sql.ts';

export * from './env.ts';
export * from './servir.ts';
export * from './sql.ts';
export * from './rate-limit.ts';

/** Lee y valida el entorno del proceso; lanza ErrorEntorno al arrancar si falta algo. */
export function entornoDeno<K extends ClaveEntorno>(claves: readonly K[]): Entorno<K> {
  return leerEntorno(claves, Deno.env.toObject());
}

let cliente: SqlClient | null = null;

/**
 * SqlClient real sobre SUPABASE_DB_URL (una conexión pequeña por isolate, reutilizada).
 * prepare:false porque el pooler de Supabase (Supavisor, puerto 6543) va en modo transacción.
 */
export function sqlDeno(dbUrl: string): SqlClient {
  cliente ??= sqlClientDesdePostgres(
    postgres(dbUrl, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10, onnotice: () => {}, types: TIPOS_JSON_POSTGRES }) as unknown as PostgresLike,
  );
  return cliente;
}
