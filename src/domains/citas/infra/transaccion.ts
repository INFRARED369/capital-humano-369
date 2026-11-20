/** Ejecuta un caso de uso en su propia transacción y la revierte si devuelve error. */
import type { Result } from '@shared/result.ts';
import type { SqlClient } from '@shared/sql.ts';

class Revertir<E> extends Error {
  constructor(readonly resultado: Result<never, E>) {
    super('revertir');
  }
}

export async function enTransaccion<T, E>(sql: SqlClient, fn: (tx: SqlClient) => Promise<Result<T, E>>): Promise<Result<T, E>> {
  try {
    return await sql.transaction(async (tx) => {
      const r = await fn(tx);
      if (!r.ok) throw new Revertir<E>(r);
      return r;
    });
  } catch (e) {
    if (e instanceof Revertir) return e.resultado as Result<T, E>;
    throw e;
  }
}
