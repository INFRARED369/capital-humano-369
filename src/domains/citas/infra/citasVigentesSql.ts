/**
 * Implementación real del CitasVigentesPort de zoho (Z5): la fuente de verdad son las
 * citas confirmadas de citas.citas con inicio en [desde, hasta).
 */
import type { SqlClient } from '@shared/sql.ts';
import type { CitasVigentesPort } from '../zoho/application/puertos.ts';

export function crearCitasVigentesSql(sql: SqlClient): CitasVigentesPort {
  return {
    async vigentes({ desde, hasta }) {
      const { rows } = await sql.query<{ id: string; inicio: Date | string; fin: Date | string }>(
        `select id, inicio, fin from citas.citas
         where estado = 'confirmada' and inicio >= $1::timestamptz and inicio < $2::timestamptz
         order by inicio`,
        [desde, hasta],
      );
      const iso = (v: Date | string) => new Date(v).toISOString();
      return rows.map((r) => ({ citaId: r.id, inicio: iso(r.inicio), fin: iso(r.fin) }));
    },
  };
}
