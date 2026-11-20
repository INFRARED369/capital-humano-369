/** Caso de uso del dashboard: carga filas (respetando el RLS del usuario) y calcula las métricas. */
import { z } from 'zod';
import { agregarKpis, funnelPor, kpisPorVacante, serieDiaria, type Dimension, type FilaFunnel, type FilaKpi, type GrupoFunnel, type Kpis } from '../domain/kpis.ts';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const FiltroDashboardSchema = z
  .strictObject({
    desde: z.string().regex(FECHA),
    hasta: z.string().regex(FECHA),
    vacanteId: z.uuid().optional(),
    dimension: z.enum(['vacante', 'cliente', 'campana', 'origen']).default('campana'),
  })
  .refine((f) => f.desde <= f.hasta, 'El rango termina antes de empezar')
  .refine((f) => (Date.parse(f.hasta) - Date.parse(f.desde)) / 86_400_000 <= 366, 'Rango máximo: 1 año');

export type FiltroDashboard = z.input<typeof FiltroDashboardSchema>;
export type FiltroNormalizado = z.output<typeof FiltroDashboardSchema>;

/** Puerto de lectura: implementado con SQL (pruebas/servidor) y con supabase-js (panel). */
export interface FuenteDashboard {
  kpis(f: FiltroNormalizado): Promise<FilaKpi[]>;
  funnel(f: FiltroNormalizado): Promise<FilaFunnel[]>;
}

export interface Dashboard {
  filtro: FiltroNormalizado;
  kpis: Kpis;
  porVacante: Array<{ vacanteId: string; clienteId: string; kpis: Kpis }>;
  funnel: GrupoFunnel[];
  serieLeads: Array<{ dia: string; valor: number }>;
  /** Hora del último refresco de las vistas materializadas (null si no hay datos). */
  refrescadoEn: string | null;
}

export async function cargarDashboard(fuente: FuenteDashboard, filtro: FiltroDashboard): Promise<Dashboard> {
  const f = FiltroDashboardSchema.parse(filtro);
  const [kpis, funnel] = await Promise.all([fuente.kpis(f), fuente.funnel(f)]);
  const refrescos = kpis.map((k) => String(k.refrescado_en)).sort();
  return {
    filtro: f,
    kpis: agregarKpis(kpis),
    porVacante: kpisPorVacante(kpis),
    funnel: funnelPor(funnel, f.dimension as Dimension),
    serieLeads: serieDiaria(kpis, 'leads'),
    refrescadoEn: refrescos.at(-1) ?? null,
  };
}
