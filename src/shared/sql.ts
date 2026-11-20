/**
 * Puerto SQL mínimo. Implementado por PGlite (pruebas) y por el driver `postgres`
 * en las edge functions (Deno). Los repositorios de infra dependen solo de esto.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
