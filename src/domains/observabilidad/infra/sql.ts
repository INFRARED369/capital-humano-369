/** RepoAlertasPort sobre shared.evaluar_alertas / alertas_pendientes / alertas_marcar (solo service_role). */
import type { SqlClient } from '@shared/sql.ts';
import type { Alerta, Severidad, TipoAlerta } from '../domain/alertas.ts';
import type { RepoAlertasPort } from '../application/ejecutar.ts';

interface FilaAlerta { id: string; tipo: TipoAlerta; severidad: Severidad; clave: string; detalle: Record<string, unknown>; creada_en: string | Date }

export function crearRepoAlertasSql(sql: SqlClient): RepoAlertasPort {
  return {
    async evaluar(ahora, config = {}) {
      const { rows } = await sql.query<{ r: { nuevas: number; tipos: string[] } }>(`select shared.evaluar_alertas($1::timestamptz, $2::jsonb) as r`, [ahora.toISOString(), JSON.stringify(config)]);
      return rows[0]!.r;
    },
    async pendientes(n) {
      const { rows } = await sql.query<FilaAlerta>(`select id::text as id, tipo, severidad, clave, detalle, creada_en from shared.alertas_pendientes($1)`, [n]);
      return rows.map((f): Alerta => ({ id: f.id, tipo: f.tipo, severidad: f.severidad, clave: f.clave, detalle: f.detalle, creadaEn: new Date(f.creada_en).toISOString() }));
    },
    async marcar(ids, ok, detalle) {
      await sql.query(`select shared.alertas_marcar($1::bigint[], $2, $3)`, [ids, ok, detalle]);
    },
  };
}
