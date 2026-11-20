/** FuenteDashboard sobre SQL (`dashboard.api_*`). Con la sesión del usuario aplica S1 por sí sola. */
import type { SqlClient } from '@shared/sql.ts';
import type { FiltroNormalizado, FuenteDashboard } from '../application/cargarDashboard.ts';
import type { FilaFunnel, FilaKpi } from '../domain/kpis.ts';

const filtroSql = (f: FiltroNormalizado) => ({
  where: `dia between $1::date and $2::date${f.vacanteId ? ' and vacante_id = $3' : ''}`,
  params: f.vacanteId ? [f.desde, f.hasta, f.vacanteId] : [f.desde, f.hasta],
});

export function crearFuenteDashboardSql(sql: SqlClient): FuenteDashboard {
  return {
    async kpis(f) {
      const { where, params } = filtroSql(f);
      const { rows } = await sql.query<FilaKpi>(
        `select to_char(dia, 'YYYY-MM-DD') as dia, vacante_id, cliente_id, visitas, formularios, leads, verificados, citas_confirmadas,
                retenidas, confirmadas, asistio, no_asistio, cupo, costo_mxn, costo_whatsapp_mxn, intentos, exitosos, fallidos, refrescado_en::text as refrescado_en
         from dashboard.api_kpis_diarios where ${where} order by dia, vacante_id`,
        params,
      );
      return rows;
    },
    async funnel(f) {
      const { where, params } = filtroSql(f);
      const { rows } = await sql.query<FilaFunnel>(
        `select to_char(dia, 'YYYY-MM-DD') as dia, vacante_id, cliente_id, campana, origen, evento, eventos from dashboard.api_funnel where ${where}`,
        params,
      );
      return rows;
    },
  };
}
