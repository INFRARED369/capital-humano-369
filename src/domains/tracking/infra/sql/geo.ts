/** TRK-07 · RepoGeoPort sobre tracking.eventos_sin_geo / tracking.fijar_geo (solo service_role). */
import type { SqlClient } from '@shared/sql.ts';
import type { RepoGeoPort } from '../../application/puertos.ts';

export function crearRepoGeoSql(sql: SqlClient): RepoGeoPort {
  return {
    async pendientes(n) {
      // creado_en viaja como TEXTO ISO con microsegundos: es parte de la PK de la tabla particionada y un Date
      // de JS lo truncaría a milisegundos (el update no encontraría la fila en Postgres real).
      const { rows } = await sql.query<{ event_id: string; creado_en: string; ip: string }>(
        `select event_id::text as event_id, to_char(creado_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as creado_en, ip from tracking.eventos_sin_geo($1)`, [n]);
      return rows.map((r) => ({ eventId: r.event_id, creadoEn: r.creado_en, ip: String(r.ip) }));
    },
    async fijar(items) {
      if (items.length === 0) return 0;
      const datos = items.map((i) => ({ event_id: i.eventId, creado_en: i.creadoEn, ciudad: i.geo?.ciudad ?? null, region: i.geo?.region ?? null, pais: i.geo?.pais ?? null }));
      const { rows } = await sql.query<{ n: number }>(`select tracking.fijar_geo($1::jsonb) as n`, [JSON.stringify(datos)]);
      return Number(rows[0]?.n ?? 0);
    },
  };
}
