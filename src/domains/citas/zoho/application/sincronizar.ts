/**
 * Sincroniza UNA cita con Zoho a partir de su estado deseado en citas.zoho_eventos (CIT-08).
 * Basado en estado (no en el mensaje): procesar el mismo trabajo N veces converge al mismo
 * resultado (Z2). Antes de crear busca el UID propio en el calendario por si un intento
 * previo creó el evento y cayó antes de guardar el uid.
 */
import { err, ok, type Result } from '@shared/result.ts';
import { construirEventoMinimo, difiereDelEsperado, type EventoCalendario } from '../domain/evento.ts';
import type { ErrorCalendario, EventoRemoto } from '../domain/tipos.ts';
import type { CalendarioExternoPort, DepsSync, RegistroZoho } from './puertos.ts';

export type ResultadoSync = 'creado' | 'actualizado' | 'adoptado' | 'sin_cambios' | 'borrado' | 'omitido';

const DIA_MS = 86_400_000;
const NO_SINCRONIZABLES = new Set(['reemplazado', 'sin_calendario', 'borrado']);

/** Busca un evento nuestro por UID propio alrededor del horario de la cita. */
export async function buscarPorUidPropio(
  calendario: CalendarioExternoPort, cal: string, uidPropio: string, inicio: string, fin: string,
): Promise<Result<EventoRemoto | null, ErrorCalendario>> {
  const rango = { desde: new Date(Date.parse(inicio) - DIA_MS).toISOString(), hasta: new Date(Date.parse(fin) + DIA_MS).toISOString() };
  const l = await calendario.listar(cal, rango);
  return l.ok ? ok(l.value.find((e) => e.uidPropio === uidPropio) ?? null) : l;
}

/** Evento remoto actual de la cita: por uid guardado o, si no existe, por UID propio. */
async function localizar(d: DepsSync, cal: string, reg: RegistroZoho): Promise<Result<EventoRemoto | null, ErrorCalendario>> {
  if (reg.zohoEventUid) {
    const r = await d.calendario.obtener(cal, reg.zohoEventUid);
    if (!r.ok || r.value) return r;
  }
  return buscarPorUidPropio(d.calendario, cal, reg.uidPropio, reg.inicio, reg.fin);
}

export function eventoDe(d: Pick<DepsSync, 'cfgEvento'>, reg: RegistroZoho): Result<EventoCalendario, ErrorCalendario> {
  const e = construirEventoMinimo({ citaId: reg.citaId, folio: reg.folio, nombrePila: reg.nombrePila ?? '', inicio: reg.inicio, fin: reg.fin }, d.cfgEvento);
  return e.ok ? e : err({ tipo: 'permanente', mensaje: `evento inválido: ${e.error}` });
}

async function publicar(d: DepsSync, cal: string, reg: RegistroZoho): Promise<Result<ResultadoSync, ErrorCalendario>> {
  const ev = eventoDe(d, reg);
  if (!ev.ok) return ev;
  const remoto = await localizar(d, cal, reg);
  if (!remoto.ok) return remoto;

  if (!remoto.value) {
    const c = await d.calendario.crear(cal, ev.value);
    if (!c.ok) return c;
    await d.repo.marcarSincronizado(reg.citaId, c.value.uid);
    return ok('creado');
  }
  const r = remoto.value;
  const campos = difiereDelEsperado(ev.value, r);
  if (campos.length > 0) {
    const u = await d.calendario.actualizar(cal, r.uid, r.etag, ev.value);
    if (!u.ok) return u;
  }
  await d.repo.marcarSincronizado(reg.citaId, r.uid);
  if (campos.length > 0) return ok('actualizado');
  return ok(r.uid === reg.zohoEventUid ? 'sin_cambios' : 'adoptado');
}

async function retirar(d: DepsSync, cal: string, reg: RegistroZoho): Promise<Result<ResultadoSync, ErrorCalendario>> {
  const remoto = await localizar(d, cal, reg);
  if (!remoto.ok) return remoto;
  if (remoto.value) {
    const b = await d.calendario.borrar(cal, remoto.value.uid, remoto.value.etag);
    if (!b.ok) return b;
  }
  await d.repo.marcarBorrado(reg.citaId);
  return ok(remoto.value ? 'borrado' : 'omitido');
}

export async function sincronizarCita(d: DepsSync, citaId: string): Promise<Result<ResultadoSync, ErrorCalendario>> {
  const reg = await d.repo.obtener(citaId);
  if (!reg || !reg.zohoCalendarUid || NO_SINCRONIZABLES.has(reg.estadoSync)) return ok('omitido');
  return reg.vigente ? publicar(d, reg.zohoCalendarUid, reg) : retirar(d, reg.zohoCalendarUid, reg);
}
