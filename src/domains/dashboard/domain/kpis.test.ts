import { describe, expect, it } from 'vitest';
import { ETAPAS_FUNNEL, agregarKpis, funnelPor, kpisPorVacante, serieDiaria, type FilaFunnel, type FilaKpi } from './kpis.ts';

const VA = 'a0000000-0000-4000-8000-000000000001';
const VB = 'b0000000-0000-4000-8000-000000000001';
const CA = 'ca000000-0000-4000-8000-000000000001';

const fila = (over: Partial<FilaKpi> = {}): FilaKpi => ({
  dia: '2026-11-17', vacante_id: VA, cliente_id: CA, visitas: 0, formularios: 0, leads: 0, verificados: 0, citas_confirmadas: 0,
  retenidas: 0, confirmadas: 0, asistio: 0, no_asistio: 0, cupo: null, costo_mxn: 0, costo_whatsapp_mxn: 0, intentos: 0, exitosos: 0, fallidos: 0,
  refrescado_en: '2026-11-17T18:00:00Z', ...over,
});

describe('agregarKpis (DSH-02, DSH-03)', () => {
  it('sin filas: conteos en 0 y razones null (nunca divide entre 0)', () => {
    const k = agregarKpis([]);
    expect(k).toMatchObject({ leads: 0, costoMxn: 0, costoPorLead: null, costoPorVerificado: null, costoPorAsistencia: null, tasaNoShow: null, tasaVerificacion: null });
    expect(k.ocupacion).toEqual({ ocupadas: 0, cupo: 0, tasa: null });
  });

  it('suma días y calcula costo por lead / verificado / asistencia, no-show, verificación OTP y ocupación x/cupo', () => {
    const k = agregarKpis([
      fila({ leads: 4, verificados: 2, asistio: 1, no_asistio: 1, confirmadas: 2, retenidas: 1, cupo: 10, costo_mxn: 2, fallidos: 1 }),
      fila({ dia: '2026-11-18', leads: 6, verificados: 3, asistio: 3, no_asistio: 1, cupo: 5, costo_mxn: 3 }),
      fila({ dia: '2026-11-19', leads: 1, costo_mxn: 1 }), // día sin citas: no cuenta en la ocupación
    ]);
    expect(k.leads).toBe(11);
    expect(k.verificados).toBe(5);
    expect(k.asistencias).toBe(4);
    expect(k.noShows).toBe(2);
    expect(k.costoMxn).toBe(6);
    expect(k.costoPorLead).toBeCloseTo(6 / 11);
    expect(k.costoPorVerificado).toBeCloseTo(6 / 5);
    expect(k.costoPorAsistencia).toBeCloseTo(6 / 4);
    expect(k.tasaNoShow).toBeCloseTo(2 / 6);
    expect(k.tasaVerificacion).toBeCloseTo(5 / 11);
    expect(k.ocupacion).toEqual({ ocupadas: 5 + 4, cupo: 15, tasa: 9 / 15 });
    expect(k.mensajesFallidos).toBe(1);
  });

  it('agrupa por vacante, ordenado por leads desc', () => {
    const g = kpisPorVacante([fila({ leads: 1 }), fila({ vacante_id: VB, leads: 5 }), fila({ dia: '2026-11-18', leads: 1 })]);
    expect(g.map((x) => [x.vacanteId, x.kpis.leads])).toEqual([[VB, 5], [VA, 2]]);
  });

  it('serie diaria ordenada por día para una métrica', () => {
    expect(serieDiaria([fila({ dia: '2026-11-18', leads: 2 }), fila({ leads: 1 }), fila({ vacante_id: VB, leads: 3 })], 'leads')).toEqual([
      { dia: '2026-11-17', valor: 4 },
      { dia: '2026-11-18', valor: 2 },
    ]);
  });
});

describe('funnelPor (DSH-01)', () => {
  const ff = (over: Partial<FilaFunnel>): FilaFunnel => ({ dia: '2026-11-17', vacante_id: VA, cliente_id: CA, campana: 'c1', origen: 'meta_pagado', evento: 'PageView', eventos: 1, ...over });
  const filas = [
    ff({ evento: 'PageView', eventos: 100 }),
    ff({ evento: 'FormSubmitted', eventos: 20 }),
    ff({ evento: 'LeadCreado', eventos: 10 }),
    ff({ evento: 'WhatsAppVerificado', eventos: 5 }),
    ff({ campana: null, origen: 'directo', evento: 'PageView', eventos: 10 }),
    ff({ vacante_id: VB, evento: 'LeadCreado', eventos: 3 }),
    ff({ evento: 'VideoPlay', eventos: 7 }), // fuera de las etapas: se ignora
  ];

  it('por campaña: etapas en orden fijo con tasa desde la etapa anterior y desde el inicio', () => {
    const g = funnelPor(filas, 'campana');
    expect(g.map((x) => x.clave)).toEqual(['c1', '(sin campaña)']);
    const c1 = g[0]!;
    expect(c1.etapas.map((e) => e.evento)).toEqual([...ETAPAS_FUNNEL]);
    expect(c1.etapas.find((e) => e.evento === 'LeadCreado')).toMatchObject({ total: 13, tasaPaso: 13 / 20, tasaInicio: 13 / 100 });
    expect(c1.etapas[0]).toMatchObject({ evento: 'PageView', total: 100, tasaPaso: null, tasaInicio: 1 });
    expect(c1.etapas.find((e) => e.evento === 'AsistenciaRegistrada')).toMatchObject({ total: 0, tasaPaso: null });
  });

  it('por origen, vacante y cliente', () => {
    expect(funnelPor(filas, 'origen').map((g) => g.clave)).toEqual(['meta_pagado', 'directo']);
    expect(funnelPor(filas, 'vacante').map((g) => g.clave)).toEqual([VA, VB]);
    expect(funnelPor(filas, 'cliente').map((g) => g.clave)).toEqual([CA]);
    expect(funnelPor([ff({ vacante_id: null })], 'vacante')[0]!.clave).toBe('(sin vacante)');
  });
});
