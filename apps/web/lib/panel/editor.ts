/** Lógica pura del editor de reglas (DSH-04): conversión de campos y vista previa de slots. */
import { generarSlots } from '../../../../src/domains/citas';
import type { Problema, ReglasVacante } from '../../../../src/domains/vacantes';
import type { Clock } from '../../../../src/shared/clock';
import { err, ok, type Result } from '../../../../src/shared/result';

const HORA = '([01]\\d|2[0-3]):[0-5]\\d';
const RE_VENTANA = new RegExp(`^(${HORA})\\s*-\\s*(${HORA})$`);

export const ventanasATexto = (v: ReadonlyArray<{ desde: string; hasta: string }>) => v.map((x) => `${x.desde}-${x.hasta}`).join(', ');

export function textoAVentanas(texto: string): Result<Array<{ desde: string; hasta: string }>, string> {
  const partes = texto.split(',').map((s) => s.trim()).filter(Boolean);
  if (partes.length === 0) return err('Escribe al menos un rango, p. ej. 09:30-13:00');
  const out: Array<{ desde: string; hasta: string }> = [];
  for (const p of partes) {
    const m = RE_VENTANA.exec(p);
    if (!m) return err(`Rango inválido: usa HH:MM-HH:MM (24 h)`);
    out.push({ desde: m[1]!, hasta: m[3]! });
  }
  return ok(out);
}

export function textoAFechas(texto: string): Result<string[], string> {
  const partes = texto.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (partes.some((p) => !/^\d{4}-\d{2}-\d{2}$/.test(p))) return err('Usa fechas AAAA-MM-DD separadas por coma');
  return ok(partes);
}

/** Copia con `ruta` (a.b.c) = valor; undefined elimina la llave. No muta la entrada. */
export function asignar<T>(obj: T, ruta: string, valor: unknown): T {
  const [k, ...resto] = ruta.split('.');
  const base = (obj && typeof obj === 'object' ? { ...(obj as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (resto.length === 0) {
    if (valor === undefined) delete base[k!];
    else base[k!] = valor;
  } else base[k!] = asignar(base[k!], resto.join('.'), valor);
  return base as T;
}

export interface DiaVistaPrevia { fecha: string; etiqueta: string; horas: string[]; capacidad: number; cupo: number }

const etiquetaFecha = (fecha: string) =>
  new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${fecha}T12:00:00Z`));

/** Slots de los próximos `dias` días con oferta, sin ocupación (lo que vería un candidato con la agenda vacía). */
export function vistaPrevia(reglas: ReglasVacante, clock: Clock, dias = 7): DiaVistaPrevia[] {
  const porFecha = new Map<string, string[]>();
  for (const s of generarSlots(reglas.agenda, [], clock)) {
    if (!porFecha.has(s.fecha)) {
      if (porFecha.size >= dias) break;
      porFecha.set(s.fecha, []);
    }
    porFecha.get(s.fecha)!.push(s.horaLocal);
  }
  return [...porFecha].map(([fecha, horas]) => ({ fecha, etiqueta: etiquetaFecha(fecha), horas, capacidad: reglas.agenda.capacidad_por_slot, cupo: reglas.agenda.cupo_diario }));
}

/** Desfase (min) de la zona en ese instante, con Intl (sin dependencias). */
function offsetMin(t: number, zona: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Math.round((Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - Math.floor(t / 60_000) * 60_000) / 60_000);
}

/** 'AAAA-MM-DD' + 'HH:MM' en la zona → ISO UTC (dos pasadas por si hay horario de verano). */
export function localAIso(fecha: string, hora: string, zona: string): string {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  const [h, mi] = hora.split(':').map(Number) as [number, number];
  const ingenuo = Date.UTC(y, m - 1, d, h, mi);
  let t = ingenuo - offsetMin(ingenuo, zona) * 60_000;
  t = ingenuo - offsetMin(t, zona) * 60_000;
  return new Date(t).toISOString();
}

export function bloqueoDesdeFormulario(d: { fecha: string; desde: string; hasta: string; motivo: string }, zona: string): Result<{ desde: string; hasta: string; motivo?: string }, string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha) || !new RegExp(`^${HORA}$`).test(d.desde) || !new RegExp(`^${HORA}$`).test(d.hasta)) return err('Indica fecha y horas válidas');
  if (d.desde >= d.hasta) return err('La hora final debe ser posterior a la inicial');
  const motivo = d.motivo.trim().slice(0, 120);
  return ok({ desde: localAIso(d.fecha, d.desde, zona), hasta: localAIso(d.fecha, d.hasta, zona), ...(motivo ? { motivo } : {}) });
}

export function problemasPorCampo(problemas: readonly Problema[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of problemas) out[p.ruta] ??= p.mensaje;
  return out;
}
