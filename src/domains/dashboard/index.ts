/**
 * API pública del dominio dashboard (DSH-01..03). SQL público: `dashboard.api_kpis_diarios`,
 * `dashboard.api_funnel` (filtradas por shared.puede_ver_vacante) y `dashboard.refrescar()` (service_role/cron).
 */
export {
  agregarKpis,
  kpisPorVacante,
  serieDiaria,
  funnelPor,
  ETAPAS_FUNNEL,
  ETIQUETAS_ETAPA,
  type FilaKpi,
  type FilaFunnel,
  type Kpis,
  type Dimension,
  type GrupoFunnel,
  type EtapaCalculada,
  type EtapaFunnel,
  type MetricaSerie,
} from './domain/kpis.ts';
export { escalaBarras, formatoMxn, formatoPct, formatoNumero } from './domain/graficas.ts';
export { cargarDashboard, FiltroDashboardSchema, type FuenteDashboard, type FiltroDashboard, type FiltroNormalizado, type Dashboard } from './application/cargarDashboard.ts';
export { crearFuenteDashboardSql } from './infra/fuenteSql.ts';
