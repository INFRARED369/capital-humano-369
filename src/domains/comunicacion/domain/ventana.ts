/**
 * COM-05 / M6 · Ventana horaria de contacto en la zona horaria de la vacante.
 * Sin librerías: usa Intl para convertir entre UTC y hora local (soporta horario de verano).
 */
import type { VentanaContacto } from './plantillas.ts';
import type { TipoMensaje } from './tipos.ts';

export interface PartesLocales {
  anio: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  diaSemana: number;
}

const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formateadores = new Map<string, Intl.DateTimeFormat>();

function formateador(tz: string): Intl.DateTimeFormat {
  let f = formateadores.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formateadores.set(tz, f);
  }
  return f;
}

export function partesLocales(fecha: Date, tz: string): PartesLocales {
  const p = Object.fromEntries(formateador(tz).formatToParts(fecha).map((x) => [x.type, x.value]));
  return { anio: Number(p.year), mes: Number(p.month), dia: Number(p.day), hora: Number(p.hour), minuto: Number(p.minute), diaSemana: DIAS[p.weekday!]! };
}

/** Convierte una hora local (pared) a instante UTC en la zona `tz`. */
export function localAUtc(anio: number, mes: number, dia: number, hora: number, minuto: number, tz: string): Date {
  const comoUtc = Date.UTC(anio, mes - 1, dia, hora, minuto);
  let t = comoUtc;
  for (let i = 0; i < 2; i++) {
    const p = partesLocales(new Date(t), tz);
    const offset = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto) - t;
    t = comoUtc - offset;
  }
  return new Date(t);
}

const minutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function dentroDeVentana(fecha: Date, v: VentanaContacto): boolean {
  const p = partesLocales(fecha, v.zona_horaria);
  const m = p.hora * 60 + p.minuto;
  return v.dias.includes(p.diaSemana) && m >= minutos(v.inicio) && m < minutos(v.fin);
}

/** Devuelve la fecha si está en ventana; si no, el siguiente inicio de ventana. El OTP nunca se pospone. */
export function ajustarAVentana(fecha: Date, v: VentanaContacto, tipo: TipoMensaje): Date {
  if (tipo === 'otp' || dentroDeVentana(fecha, v)) return fecha;
  const [hi, mi] = [Number(v.inicio.slice(0, 2)), Number(v.inicio.slice(3, 5))];
  const p = partesLocales(fecha, v.zona_horaria);
  for (let d = 0; d <= 7; d++) {
    // mediodía local del día d para obtener la fecha calendario sin problemas de DST
    const base = partesLocales(new Date(localAUtc(p.anio, p.mes, p.dia, 12, 0, v.zona_horaria).getTime() + d * 86_400_000), v.zona_horaria);
    const candidato = localAUtc(base.anio, base.mes, base.dia, hi, mi, v.zona_horaria);
    if (candidato > fecha && v.dias.includes(base.diaSemana)) return candidato;
  }
  /* c8 ignore next */
  return fecha;
}

/** Fecha y hora legibles para las plantillas (es-MX). */
export function formatearFechaHora(fecha: Date, tz: string): { fecha: string; hora: string } {
  return {
    fecha: new Intl.DateTimeFormat('es-MX', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(fecha),
    hora: new Intl.DateTimeFormat('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(fecha),
  };
}
