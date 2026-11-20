/**
 * Métricas del dashboard (DSH-01..03). Puro: recibe filas de `dashboard.api_kpis_diarios` y
 * `dashboard.api_funnel` y calcula razones sobre el rango (nunca promedia razones diarias).
 * Costos = costos de mensajería registrados por comunicación (COM-03); la inversión en anuncios no vive
 * en el sistema.
 */
export interface FilaKpi {
  dia: string;
  vacante_id: string;
  cliente_id: string;
  visitas: number;
  formularios: number;
  leads: number;
  verificados: number;
  citas_confirmadas: number;
  retenidas: number;
  confirmadas: number;
  asistio: number;
  no_asistio: number;
  /** Cupo diario de las reglas vigentes; null si ese día no hubo citas. */
  cupo: number | null;
  costo_mxn: number;
  costo_whatsapp_mxn: number;
  intentos: number;
  exitosos: number;
  fallidos: number;
  refrescado_en: string;
}

export interface FilaFunnel {
  dia: string;
  vacante_id: string | null;
  cliente_id: string;
  campana: string | null;
  origen: string;
  evento: string;
  eventos: number;
}

export interface Kpis {
  visitas: number;
  leads: number;
  verificados: number;
  citasConfirmadas: number;
  asistencias: number;
  noShows: number;
  costoMxn: number;
  costoPorLead: number | null;
  costoPorVerificado: number | null;
  costoPorAsistencia: number | null;
  /** Ocupación x/cupo sobre los días con citas (retenidas vigentes + confirmadas + asistió + no asistió). */
  ocupacion: { ocupadas: number; cupo: number; tasa: number | null };
  /** no asistió / (asistió + no asistió). */
  tasaNoShow: number | null;
  /** WhatsApp verificado (OTP) / leads. */
  tasaVerificacion: number | null;
  mensajesFallidos: number;
}

const razon = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function agregarKpis(filas: readonly FilaKpi[]): Kpis {
  const s = { visitas: 0, leads: 0, verificados: 0, citas: 0, asistio: 0, noAsistio: 0, costo: 0, ocupadas: 0, cupo: 0, fallidos: 0 };
  for (const f of filas) {
    s.visitas += n(f.visitas);
    s.leads += n(f.leads);
    s.verificados += n(f.verificados);
    s.citas += n(f.citas_confirmadas);
    s.asistio += n(f.asistio);
    s.noAsistio += n(f.no_asistio);
    s.costo += n(f.costo_mxn);
    s.fallidos += n(f.fallidos);
    if (f.cupo !== null && f.cupo !== undefined) {
      s.cupo += n(f.cupo);
      s.ocupadas += n(f.retenidas) + n(f.confirmadas) + n(f.asistio) + n(f.no_asistio);
    }
  }
  return {
    visitas: s.visitas,
    leads: s.leads,
    verificados: s.verificados,
    citasConfirmadas: s.citas,
    asistencias: s.asistio,
    noShows: s.noAsistio,
    costoMxn: s.costo,
    costoPorLead: razon(s.costo, s.leads),
    costoPorVerificado: razon(s.costo, s.verificados),
    costoPorAsistencia: razon(s.costo, s.asistio),
    ocupacion: { ocupadas: s.ocupadas, cupo: s.cupo, tasa: razon(s.ocupadas, s.cupo) },
    tasaNoShow: razon(s.noAsistio, s.asistio + s.noAsistio),
    tasaVerificacion: razon(s.verificados, s.leads),
    mensajesFallidos: s.fallidos,
  };
}

function agrupar<T, K>(xs: readonly T[], clave: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = clave(x);
    const l = m.get(k);
    if (l) l.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function kpisPorVacante(filas: readonly FilaKpi[]): Array<{ vacanteId: string; clienteId: string; kpis: Kpis }> {
  return [...agrupar(filas, (f) => f.vacante_id)]
    .map(([vacanteId, fs]) => ({ vacanteId, clienteId: fs[0]!.cliente_id, kpis: agregarKpis(fs) }))
    .sort((a, b) => b.kpis.leads - a.kpis.leads || a.vacanteId.localeCompare(b.vacanteId));
}

export type MetricaSerie = 'visitas' | 'leads' | 'verificados' | 'citas_confirmadas' | 'asistio' | 'no_asistio' | 'costo_mxn';

export function serieDiaria(filas: readonly FilaKpi[], metrica: MetricaSerie): Array<{ dia: string; valor: number }> {
  return [...agrupar(filas, (f) => f.dia)]
    .map(([dia, fs]) => ({ dia, valor: fs.reduce((a, f) => a + n(f[metrica]), 0) }))
    .sort((a, b) => a.dia.localeCompare(b.dia));
}

/** Etapas del funnel (TRK-04) en orden. */
export const ETAPAS_FUNNEL = ['PageView', 'ClickCTA', 'FormSubmitted', 'LeadCreado', 'WhatsAppVerificado', 'CitaConfirmada', 'AsistenciaRegistrada'] as const;
export type EtapaFunnel = (typeof ETAPAS_FUNNEL)[number];
export const ETIQUETAS_ETAPA: Record<EtapaFunnel, string> = {
  PageView: 'Visitas',
  ClickCTA: 'Clic en el botón',
  FormSubmitted: 'Formulario enviado',
  LeadCreado: 'Leads',
  WhatsAppVerificado: 'WhatsApp verificado',
  CitaConfirmada: 'Cita confirmada',
  AsistenciaRegistrada: 'Asistencia registrada',
};

export type Dimension = 'vacante' | 'cliente' | 'campana' | 'origen';

export interface EtapaCalculada { evento: EtapaFunnel; etiqueta: string; total: number; tasaPaso: number | null; tasaInicio: number | null }
export interface GrupoFunnel { clave: string; etapas: EtapaCalculada[]; total: number }

const claveDe: Record<Dimension, (f: FilaFunnel) => string> = {
  vacante: (f) => f.vacante_id ?? '(sin vacante)',
  cliente: (f) => f.cliente_id,
  campana: (f) => f.campana ?? '(sin campaña)',
  origen: (f) => f.origen,
};

export function funnelPor(filas: readonly FilaFunnel[], dimension: Dimension): GrupoFunnel[] {
  const etapas = new Set<string>(ETAPAS_FUNNEL);
  const grupos = [...agrupar(filas.filter((f) => etapas.has(f.evento)), claveDe[dimension])].map(([clave, fs]) => {
    const totales = new Map<string, number>();
    for (const f of fs) totales.set(f.evento, (totales.get(f.evento) ?? 0) + n(f.eventos));
    const inicio = totales.get(ETAPAS_FUNNEL[0]) ?? 0;
    const calc = ETAPAS_FUNNEL.map((evento, i): EtapaCalculada => {
      const total = totales.get(evento) ?? 0;
      const previo = i === 0 ? null : (totales.get(ETAPAS_FUNNEL[i - 1]!) ?? 0);
      return { evento, etiqueta: ETIQUETAS_ETAPA[evento], total, tasaPaso: previo === null ? null : total === 0 && previo === 0 ? null : razon(total, previo), tasaInicio: razon(total, inicio) };
    });
    return { clave, etapas: calc, total: [...totales.values()].reduce((a, b) => a + b, 0) };
  });
  return grupos.sort((a, b) => b.total - a.total || a.clave.localeCompare(b.clave));
}
