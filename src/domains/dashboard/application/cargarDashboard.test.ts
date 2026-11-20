import { describe, expect, it, vi } from 'vitest';
import { cargarDashboard, type FuenteDashboard } from './cargarDashboard.ts';

const VA = 'a0000000-0000-4000-8000-000000000001';

function fuente(): FuenteDashboard {
  return {
    kpis: vi.fn(async () => [
      { dia: '2026-11-17', vacante_id: VA, cliente_id: VA, visitas: 10, formularios: 2, leads: 2, verificados: 1, citas_confirmadas: 1, retenidas: 0, confirmadas: 1, asistio: 0, no_asistio: 0, cupo: 10, costo_mxn: 1, costo_whatsapp_mxn: 1, intentos: 2, exitosos: 2, fallidos: 0, refrescado_en: '2026-11-17T18:00:00Z' },
      { dia: '2026-11-18', vacante_id: VA, cliente_id: VA, visitas: 0, formularios: 0, leads: 1, verificados: 0, citas_confirmadas: 0, retenidas: 0, confirmadas: 0, asistio: 0, no_asistio: 0, cupo: null, costo_mxn: 0, costo_whatsapp_mxn: 0, intentos: 0, exitosos: 0, fallidos: 0, refrescado_en: '2026-11-17T18:10:00Z' },
    ]),
    funnel: vi.fn(async () => [{ dia: '2026-11-17', vacante_id: VA, cliente_id: VA, campana: null, origen: 'directo', evento: 'PageView', eventos: 10 }]),
  };
}

describe('cargarDashboard', () => {
  it('normaliza el filtro (dimensión por defecto: campaña) y arma KPIs, serie, funnel y hora de refresco', async () => {
    const f = fuente();
    const d = await cargarDashboard(f, { desde: '2026-11-01', hasta: '2026-11-30' });
    expect(f.kpis).toHaveBeenCalledWith({ desde: '2026-11-01', hasta: '2026-11-30', dimension: 'campana' });
    expect(d.kpis.leads).toBe(3);
    expect(d.serieLeads).toEqual([{ dia: '2026-11-17', valor: 2 }, { dia: '2026-11-18', valor: 1 }]);
    expect(d.funnel[0]!.clave).toBe('(sin campaña)');
    expect(d.refrescadoEn).toBe('2026-11-17T18:10:00Z');
  });

  it('rechaza filtros inválidos (fechas, rango invertido o mayor a un año, vacante no uuid)', async () => {
    for (const filtro of [
      { desde: '2026/11/01', hasta: '2026-11-30' },
      { desde: '2026-12-01', hasta: '2026-11-30' },
      { desde: '2024-01-01', hasta: '2026-11-30' },
      { desde: '2026-11-01', hasta: '2026-11-30', vacanteId: 'x' },
    ]) {
      await expect(cargarDashboard(fuente(), filtro)).rejects.toThrow();
    }
  });

  it('sin datos: refrescadoEn null', async () => {
    const d = await cargarDashboard({ kpis: async () => [], funnel: async () => [] }, { desde: '2026-11-01', hasta: '2026-11-02', dimension: 'origen' });
    expect(d.refrescadoEn).toBeNull();
    expect(d.funnel).toEqual([]);
  });
});
