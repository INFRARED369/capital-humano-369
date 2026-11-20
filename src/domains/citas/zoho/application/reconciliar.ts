/**
 * Reconciliación con Zoho (CIT-09, Z5), cada 15 min: el SISTEMA GANA.
 *  1. Alinea citas.zoho_eventos con la fuente de verdad (CitasVigentesPort): cancelaciones
 *     perdidas, horarios distintos, calendarios configurados después (Z7 resuelto).
 *  2. Por calendario: lista Zoho en el rango, decide (función pura) y ejecuta:
 *     recrear · corregir · borrar huérfanos · adoptar. Cada drift registra ZOHO_DRIFT.
 * Solo mira citas futuras (inicio ≥ ahora): lo pasado lo borra la retención a +30 días.
 */
import { normalizarCalendarUid, type EventoCalendario } from '../domain/evento.ts';
import { decidirReconciliacion, type AccionReconciliacion, type EsperadoZoho } from '../domain/reconciliacion.ts';
import type { ErrorCalendario } from '../domain/tipos.ts';
import type { AlertaZoho, CitaVigente, DepsReconciliacion, RangoFechas, RegistroZoho } from './puertos.ts';
import { eventoDe } from './sincronizar.ts';

export interface ResumenReconciliacion {
  calendarios: number;
  acciones: number;
  drift: number;
  errores: number;
}

export interface OpcionesReconciliacion {
  horizonteDias?: number;
}

const DIA_MS = 86_400_000;
const enRango = (r: RangoFechas) => (e: { inicio: string }) => {
  const t = Date.parse(e.inicio);
  return t >= Date.parse(r.desde) && t < Date.parse(r.hasta);
};
const citaDeUidPropio = (uid: string): string | null => (/^cita-([0-9a-f-]{36})$/.exec(uid)?.[1] ?? null);

/** Paso 1: el sistema es la fuente de verdad del registro. Devuelve los registros que deben publicarse. */
interface Alineacion {
  /** Registros a revisar en Zoho (incluye los recién retirados, que aportan su calendario). */
  revisar: RegistroZoho[];
  /** Citas con calendario recién resuelto (Z7): se publican aunque estén 'pendiente'. */
  forzados: Set<string>;
  /** Citas retiradas en este paso (ya alertadas como cita_no_vigente). */
  retiradas: Set<string>;
}

async function alinearConSistema(d: DepsReconciliacion, rango: RangoFechas, r: ResumenReconciliacion): Promise<Alineacion> {
  const [vigentes, registros] = await Promise.all([d.citasVigentes.vigentes(rango), d.repo.vigentesEnRango(rango)]);
  const sistema = new Map<string, CitaVigente>(vigentes.map((v) => [v.citaId, v]));
  const conocidos = new Set(registros.map((x) => x.citaId));
  const revisar: RegistroZoho[] = [];
  const forzados = new Set<string>();
  const retiradas = new Set<string>();

  for (const reg of registros) {
    const v = sistema.get(reg.citaId);
    if (!v) {
      await d.repo.corregir(reg.citaId, { vigente: false, estadoSync: reg.zohoCalendarUid ? 'pendiente' : 'borrado' });
      await alertar(d, r, reg, { motivo: 'cita_no_vigente' });
      retiradas.add(reg.citaId);
      if (reg.zohoCalendarUid) revisar.push({ ...reg, vigente: false });
      continue;
    }
    let actual = reg;
    if (Date.parse(v.inicio) !== Date.parse(reg.inicio) || Date.parse(v.fin) !== Date.parse(reg.fin)) {
      await d.repo.corregir(reg.citaId, { inicio: v.inicio, fin: v.fin });
      actual = { ...actual, inicio: new Date(v.inicio).toISOString(), fin: new Date(v.fin).toISOString() };
    }
    if (actual.estadoSync === 'sin_calendario') {
      const cal = normalizarCalendarUid(await d.calendarioDe(actual.vacanteId));
      if (!cal) continue;
      await d.repo.corregir(actual.citaId, { zohoCalendarUid: cal, estadoSync: 'pendiente' });
      actual = { ...actual, zohoCalendarUid: cal, estadoSync: 'pendiente' };
      forzados.add(actual.citaId);
    }
    revisar.push(actual);
  }

  for (const v of vigentes) {
    if (conocidos.has(v.citaId)) continue;
    const ref = registros[0];
    if (ref) await d.alertas.registrar({ tipo: 'ZOHO_SIN_REGISTRO', clienteId: ref.clienteId, vacanteId: null, citaId: v.citaId, detalle: { motivo: 'cita vigente sin CitaConfirmada ingerida' } });
    else d.logger.warn('zoho: cita vigente sin registro', { cita_id: v.citaId });
  }
  return { revisar, forzados, retiradas };
}

async function alertar(d: DepsReconciliacion, r: ResumenReconciliacion, reg: { clienteId: string; vacanteId: string | null; citaId: string | null }, detalle: Record<string, unknown>): Promise<void> {
  r.drift++;
  const a: AlertaZoho = { tipo: 'ZOHO_DRIFT', clienteId: reg.clienteId, vacanteId: reg.vacanteId, citaId: reg.citaId, detalle };
  await d.alertas.registrar(a);
  d.logger.warn('zoho: drift', { cita_id: reg.citaId, ...detalle });
}

async function ejecutar(
  d: DepsReconciliacion, r: ResumenReconciliacion, cal: string, a: AccionReconciliacion,
  porCita: Map<string, { reg: RegistroZoho; evento: EventoCalendario }>, ref: RegistroZoho, retiradas: Set<string>,
): Promise<ErrorCalendario | null> {
  r.acciones++;
  switch (a.tipo) {
    case 'recrear': {
      const { reg, evento } = porCita.get(a.citaId)!;
      const c = await d.calendario.crear(cal, evento);
      if (!c.ok) return c.error;
      await d.repo.marcarSincronizado(reg.citaId, c.value.uid);
      if (a.motivo === 'borrado_en_zoho') await alertar(d, r, reg, { motivo: a.motivo });
      return null;
    }
    case 'adoptar':
      await d.repo.marcarSincronizado(a.citaId, a.zohoEventUid);
      return null;
    case 'corregir': {
      const { reg, evento } = porCita.get(a.citaId)!;
      const u = await d.calendario.actualizar(cal, a.zohoEventUid, a.etag, evento);
      if (!u.ok) return u.error;
      await d.repo.marcarSincronizado(reg.citaId, a.zohoEventUid);
      await alertar(d, r, reg, { motivo: 'editado_en_zoho', campos: a.campos });
      return null;
    }
    case 'borrar': {
      const b = await d.calendario.borrar(cal, a.zohoEventUid, a.etag);
      if (!b.ok) return b.error;
      const citaId = citaDeUidPropio(a.uidPropio);
      const reg = citaId ? await d.repo.obtener(citaId) : null;
      if (reg && !reg.vigente) await d.repo.corregir(reg.citaId, { estadoSync: 'borrado' });
      if (!(citaId && retiradas.has(citaId))) await alertar(d, r, reg ?? { ...ref, citaId }, { motivo: 'huerfano', uid_propio: a.uidPropio });
      return null;
    }
  }
}

export async function reconciliarZoho(d: DepsReconciliacion, opts: OpcionesReconciliacion = {}): Promise<ResumenReconciliacion> {
  const ahora = d.clock.now();
  const rango: RangoFechas = { desde: ahora.toISOString(), hasta: new Date(ahora.getTime() + (opts.horizonteDias ?? 30) * DIA_MS).toISOString() };
  const r: ResumenReconciliacion = { calendarios: 0, acciones: 0, drift: 0, errores: 0 };
  const { revisar, forzados, retiradas } = await alinearConSistema(d, rango, r);

  const porCalendario = new Map<string, RegistroZoho[]>();
  for (const reg of revisar) {
    if (!reg.zohoCalendarUid) continue;
    porCalendario.set(reg.zohoCalendarUid, [...(porCalendario.get(reg.zohoCalendarUid) ?? []), reg]);
  }

  for (const cal of [...porCalendario.keys()].sort()) {
    r.calendarios++;
    const regs = porCalendario.get(cal)!;
    const ref = regs[0]!;
    const remotos = await d.calendario.listar(cal, rango);
    if (!remotos.ok) {
      r.errores++;
      await d.alertas.registrar({ tipo: 'ZOHO_RECONCILIACION_ERROR', clienteId: ref.clienteId, vacanteId: ref.vacanteId, citaId: null, detalle: { error: remotos.error.mensaje } });
      continue;
    }

    const porCita = new Map<string, { reg: RegistroZoho; evento: EventoCalendario }>();
    const esperados: EsperadoZoho[] = [];
    for (const reg of regs) {
      // Las no vigentes no se esperan: si su evento sigue en Zoho, la decisión lo borra como huérfano.
      const ev = reg.vigente ? eventoDe(d, reg) : null;
      if (!ev?.ok) continue;
      porCita.set(reg.citaId, { reg, evento: ev.value });
      esperados.push({ citaId: reg.citaId, zohoEventUid: reg.zohoEventUid, evento: ev.value });
    }
    const acciones = decidirReconciliacion(esperados, remotos.value.filter(enRango(rango))).filter((a) => {
      // El trabajo en cola publicará lo pendiente; no competir con el worker (evita duplicados).
      if (a.tipo !== 'recrear' || a.motivo !== 'no_publicado') return true;
      const reg = porCita.get(a.citaId)!.reg;
      return reg.estadoSync !== 'pendiente' || forzados.has(a.citaId);
    });

    for (const a of acciones) {
      const e = await ejecutar(d, r, cal, a, porCita, ref, retiradas);
      if (e) {
        r.errores++;
        const citaId = 'citaId' in a ? a.citaId : null;
        await d.alertas.registrar({ tipo: 'ZOHO_RECONCILIACION_ERROR', clienteId: ref.clienteId, vacanteId: ref.vacanteId, citaId, detalle: { accion: a.tipo, error: e.mensaje } });
      }
    }
  }
  return r;
}
