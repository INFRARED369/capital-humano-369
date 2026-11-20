/**
 * Mapeo cita → evento mínimo de calendario (D9, NFR-SEG-04, Política de retención).
 * Solo lleva: "Entrevista {folio} · {nombre de pila}", horario y link al panel.
 * Nunca teléfono, nunca asistentes, sin recordatorios (Zoho no notifica a nadie).
 * Puro: sin I/O.
 */
import { err, ok, type Result } from '@shared/result.ts';
import type { EventoRemoto } from './tipos.ts';

export interface EventoCalendario {
  titulo: string;
  descripcion: string;
  /** ISO UTC */
  inicio: string;
  /** ISO UTC */
  fin: string;
  zonaHoraria: string;
  /** UID propio idempotente (va como marcador en la descripción). */
  uidPropio: string;
  /** Siempre vacío: las notificaciones de Zoho están apagadas (D9). */
  recordatorios: readonly [];
}

export interface DatosCitaEvento {
  citaId: string;
  folio: string;
  nombrePila: string;
  inicio: string;
  fin: string;
}

export interface ConfigEvento {
  panelUrl: string;
  zonaHoraria: string;
}

export type ErrorEvento = 'DATOS_INVALIDOS' | 'POSIBLE_PII';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOLIO = /^[A-Za-z0-9-]{1,24}$/;
/** Misma heurística de teléfono que el logger con redacción (10 a 13 dígitos). */
const POSIBLE_TELEFONO = /(?:\+?\d[\s-]?){10,13}/;
const MARCADOR = /\[369:(cita-[0-9a-f-]{36})\]/i;
const NOMBRE_DEFECTO = 'Candidato';
/** Un nombre con marcado o URL no se "limpia": se sustituye. */
const MARCADO = /[<>&"{}\\/:=]/;

export const uidPropioDe = (citaId: string): string => `cita-${citaId.toLowerCase()}`;
const marcador = (uid: string): string => `[369:${uid}]`;

export function extraerUidPropio(descripcion: string | null | undefined): string | null {
  const m = descripcion ? MARCADOR.exec(descripcion) : null;
  return m ? m[1]!.toLowerCase() : null;
}

/** Primer nombre, solo letras, capitalizado y acotado a 40 caracteres. */
export function nombrePilaSeguro(nombre: string): string {
  const token = nombre.trim().split(/\s+/)[0] ?? '';
  if (MARCADO.test(token)) return NOMBRE_DEFECTO;
  const primero = token.replace(/[^\p{L}'-]/gu, '').slice(0, 40);
  if (!/\p{L}/u.test(primero)) return NOMBRE_DEFECTO;
  return primero.charAt(0).toLocaleUpperCase('es-MX') + primero.slice(1).toLocaleLowerCase('es-MX');
}

const isoValido = (s: string): number | null => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

export function construirEventoMinimo(d: DatosCitaEvento, cfg: ConfigEvento): Result<EventoCalendario, ErrorEvento> {
  const ini = isoValido(d.inicio);
  const fin = isoValido(d.fin);
  if (!UUID.test(d.citaId) || ini === null || fin === null || fin <= ini) return err('DATOS_INVALIDOS');
  if (POSIBLE_TELEFONO.test(d.folio)) return err('POSIBLE_PII');
  if (!FOLIO.test(d.folio)) return err('DATOS_INVALIDOS');

  const uidPropio = uidPropioDe(d.citaId);
  const link = `${cfg.panelUrl.replace(/\/+$/, '')}/panel/citas/?id=${d.citaId.toLowerCase()}`;
  return ok({
    titulo: `Entrevista ${d.folio} · ${nombrePilaSeguro(d.nombrePila)}`,
    descripcion: `Abrir en el panel: ${link}\n\n${marcador(uidPropio)}`,
    inicio: new Date(ini).toISOString(),
    fin: new Date(fin).toISOString(),
    zonaHoraria: cfg.zonaHoraria,
    uidPropio,
    recordatorios: [],
  });
}

export type CampoDrift = 'titulo' | 'descripcion' | 'inicio' | 'fin' | 'asistentes';

const mismoInstante = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

/** Campos en los que el evento remoto difiere de lo que el sistema publicó. */
export function difiereDelEsperado(esperado: EventoCalendario, remoto: EventoRemoto): CampoDrift[] {
  const campos: CampoDrift[] = [];
  if (remoto.titulo !== esperado.titulo) campos.push('titulo');
  if (remoto.descripcion.trim() !== esperado.descripcion.trim()) campos.push('descripcion');
  if (!mismoInstante(remoto.inicio, esperado.inicio)) campos.push('inicio');
  if (!mismoInstante(remoto.fin, esperado.fin)) campos.push('fin');
  if (remoto.numAsistentes > 0) campos.push('asistentes');
  return campos;
}

const CALENDAR_UID = /^[A-Za-z0-9_@-][A-Za-z0-9._@-]{5,127}$/;

/** Valida el `zoho_calendar_uid` de las reglas de la vacante; null = configuración incompleta (Z7). */
export function normalizarCalendarUid(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const v = valor.trim();
  return CALENDAR_UID.test(v) && !v.includes('..') ? v : null;
}
