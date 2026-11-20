/** Slots que devuelve citas-api (GET /citas-api?vacante=slug); el sistema es la fuente de verdad (CIT-01). */
import type { RespuestaApi } from './api';
export interface SlotCliente { inicio: string; fecha: string; hora: string }
export interface DiaSlots { fecha: string; etiqueta: string; horas: Array<{ inicio: string; etiqueta: string }> }

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{2}:\d{2}$/;

export function parsearSlots(crudo: unknown): { zona: string; slots: SlotCliente[] } | null {
  if (!crudo || typeof crudo !== 'object') return null;
  const c = crudo as { zona_horaria?: unknown; slots?: unknown };
  if (!Array.isArray(c.slots)) return null;
  const slots: SlotCliente[] = [];
  for (const s of c.slots as Array<Record<string, unknown>>) {
    if (typeof s?.inicio_utc !== 'string' || typeof s.fecha !== 'string' || typeof s.hora_local !== 'string') continue;
    if (!FECHA.test(s.fecha) || !HORA.test(s.hora_local) || Number.isNaN(Date.parse(s.inicio_utc))) continue;
    if (typeof s.disponibles === 'number' && s.disponibles <= 0) continue;
    slots.push({ inicio: s.inicio_utc, fecha: s.fecha, hora: s.hora_local });
  }
  return { zona: typeof c.zona_horaria === 'string' ? c.zona_horaria : 'America/Monterrey', slots };
}

export function etiquetaHora(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

export function etiquetaFecha(fecha: string): string {
  const [y, mo, d] = fecha.split('-').map(Number) as [number, number, number];
  const dia = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DIAS[dia]} ${d} ${MESES[mo - 1]}`;
}

/** Agrupa por fecha LOCAL de la vacante (la que calcula el servidor), no la del navegador (C9). */
export function agruparPorDia(slots: SlotCliente[]): DiaSlots[] {
  const mapa = new Map<string, DiaSlots>();
  for (const s of [...slots].sort((a, b) => a.inicio.localeCompare(b.inicio))) {
    const d = mapa.get(s.fecha) ?? { fecha: s.fecha, etiqueta: etiquetaFecha(s.fecha), horas: [] };
    d.horas.push({ inicio: s.inicio, etiqueta: etiquetaHora(s.hora) });
    mapa.set(s.fecha, d);
  }
  return [...mapa.values()];
}

/** "Mar 17 Nov · 9:30 am" en la zona de la vacante. */
export function formatearCita(inicioIso: string, zona: string): string {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(inicioIso));
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '00';
  return `${etiquetaFecha(`${v('year')}-${v('month')}-${v('day')}`)} · ${etiquetaHora(`${v('hour')}:${v('minute')}`)}`;
}

/**
 * F7.4 · Qué pantalla sigue tras los datos según la respuesta de citas-api:
 *  - `agenda_modo: 'whatsapp'` → el candidato agenda por WhatsApp (sin pantalla de horarios);
 *  - `agenda_modo: 'sistema'` (o ausente: contrato anterior) → días y horas del sistema;
 *  - red caída, 4xx/5xx, cuerpo ilegible o modo desconocido → respaldo por WhatsApp (CAP-10).
 */
export type DecisionAgenda = { tipo: 'whatsapp' } | { tipo: 'horarios'; zona: string; dias: DiaSlots[] } | { tipo: 'fallback' };

export function interpretarAgenda(r: RespuestaApi<unknown>): DecisionAgenda {
  if (r.tipo !== 'ok') return { tipo: 'fallback' };
  const modo = (r.datos as { agenda_modo?: unknown } | null)?.agenda_modo ?? 'sistema';
  if (modo === 'whatsapp') return { tipo: 'whatsapp' };
  if (modo !== 'sistema') return { tipo: 'fallback' };
  const parsed = parsearSlots(r.datos);
  return parsed ? { tipo: 'horarios', zona: parsed.zona, dias: agruparPorDia(parsed.slots) } : { tipo: 'fallback' };
}
