/**
 * Conversiones de zona horaria con Intl (sin dependencias). Las fechas locales son
 * cadenas 'YYYY-MM-DD' y las horas 'HH:MM'; los instantes son Date (UTC).
 */
const formateadores = new Map<string, Intl.DateTimeFormat>();

function formateador(zona: string): Intl.DateTimeFormat {
  let f = formateadores.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formateadores.set(zona, f);
  }
  return f;
}

interface Partes { y: number; m: number; d: number; h: number; mi: number; s: number }

function partes(instante: Date, zona: string): Partes {
  const p: Record<string, number> = {};
  for (const { type, value } of formateador(zona).formatToParts(instante)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

/** Desfase de la zona respecto a UTC en minutos para ese instante (CDMX = -360). */
export function offsetMinutos(instante: Date, zona: string): number {
  const p = partes(instante, zona);
  const comoUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((comoUtc - Math.floor(instante.getTime() / 1000) * 1000) / 60_000);
}

export function esZonaValida(zona: string): boolean {
  try {
    formateador(zona);
    return true;
  } catch {
    return false;
  }
}

const dos = (n: number) => String(n).padStart(2, '0');

/** Instante UTC de una fecha y hora locales en la zona dada. */
export function localAUtc(fecha: string, hhmm: string, zona: string): Date {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const ingenuo = Date.UTC(y, m - 1, d, h, mi);
  // Dos pasadas: la segunda corrige si el desfase cambia entre la suposición y el resultado (DST).
  let t = ingenuo - offsetMinutos(new Date(ingenuo), zona) * 60_000;
  t = ingenuo - offsetMinutos(new Date(t), zona) * 60_000;
  return new Date(t);
}

export function fechaLocal(instante: Date, zona: string): string {
  const p = partes(instante, zona);
  return `${p.y}-${dos(p.m)}-${dos(p.d)}`;
}

export function horaLocal(instante: Date, zona: string): string {
  const p = partes(instante, zona);
  return `${dos(p.h)}:${dos(p.mi)}`;
}

/** '2026-11-17T09:30:00-06:00' */
export function isoLocalConOffset(instante: Date, zona: string): string {
  const p = partes(instante, zona);
  const off = offsetMinutos(instante, zona);
  const signo = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${p.y}-${dos(p.m)}-${dos(p.d)}T${dos(p.h)}:${dos(p.mi)}:${dos(p.s)}${signo}${dos(Math.floor(abs / 60))}:${dos(abs % 60)}`;
}

/** 1 = lunes … 7 = domingo. */
export function diaSemanaIso(fecha: string): number {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

export function sumarDias(fecha: string, n: number): string {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const minutosDeHora = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export const horaDeMinutos = (min: number): string => `${dos(Math.floor(min / 60))}:${dos(min % 60)}`;
