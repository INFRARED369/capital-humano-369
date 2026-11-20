/**
 * Motor de disponibilidad (CIT-02…CIT-04). Puro: recibe reglas, la ocupación vigente
 * de UNA vacante (retenidas vigentes + confirmadas) y un reloj.
 */
import type { Clock } from '@shared/clock.ts';
import { err, ok, type Result } from '@shared/result.ts';
import type { ReglasAgenda } from './reglas.ts';
import { diaSemanaIso, fechaLocal, horaDeMinutos, horaLocal, isoLocalConOffset, localAUtc, minutosDeHora, sumarDias } from './tiempo.ts';

export interface Slot {
  /** Inicio en UTC (ISO 8601, 'Z'). Es lo que se envía para reservar. */
  inicio: string;
  fin: string;
  /** Inicio en la zona de la vacante con su offset: '2026-11-17T09:30:00-06:00'. */
  inicioLocal: string;
  /** Fecha local de la vacante 'YYYY-MM-DD'. */
  fecha: string;
  /** Hora local 'HH:MM'. */
  horaLocal: string;
  capacidad: number;
  disponibles: number;
}

/** Cita que ocupa capacidad: retenida vigente o confirmada. */
export interface CitaActiva { inicio: string; fin: string }
export type Ocupacion = readonly CitaActiva[];

export type ErrorReserva = 'SLOT_INVALIDO' | 'SLOT_LLENO' | 'CUPO_DIARIO';

const MIN = 60_000;

function horasDeInicio(r: ReglasAgenda): string[] {
  const set = new Set<number>();
  for (const v of r.ventanas_inicio) {
    for (let m = minutosDeHora(v.desde); m <= minutosDeHora(v.hasta); m += r.intervalo_min) set.add(m);
  }
  return [...set].sort((a, b) => a - b).map(horaDeMinutos);
}

const bloqueado = (r: ReglasAgenda, t: number) => r.bloqueos.some((b) => t >= Date.parse(b.desde) && t < Date.parse(b.hasta));

function diaPermitido(r: ReglasAgenda, fecha: string, hoy: string): boolean {
  const limite = sumarDias(hoy, r.horizonte_dias - 1);
  return fecha >= hoy && fecha <= limite && r.dias_habiles.includes(diaSemanaIso(fecha)) && !r.festivos.includes(fecha);
}

/** Citas de la ocupación que consumen capacidad del intervalo [inicio, fin). */
function usadosEnSlot(r: ReglasAgenda, ocup: readonly { i: number; f: number }[], inicio: number, fin: number): number {
  return r.permitir_empalmes ? ocup.filter((c) => c.i === inicio).length : ocup.filter((c) => c.i < fin && c.f > inicio).length;
}

function indexar(r: ReglasAgenda, ocupacion: Ocupacion) {
  const porDia = new Map<string, { i: number; f: number }[]>();
  for (const c of ocupacion) {
    const i = Date.parse(c.inicio);
    const fecha = fechaLocal(new Date(i), r.zona_horaria);
    const lista = porDia.get(fecha) ?? [];
    lista.push({ i, f: Date.parse(c.fin) });
    porDia.set(fecha, lista);
  }
  return porDia;
}

export function generarSlots(reglas: ReglasAgenda, ocupacion: Ocupacion, clock: Clock): Slot[] {
  const ahora = clock.now();
  const zona = reglas.zona_horaria;
  const hoy = fechaLocal(ahora, zona);
  const minimo = ahora.getTime() + reglas.antelacion_min_horas * 60 * MIN;
  const horas = horasDeInicio(reglas);
  const porDia = indexar(reglas, ocupacion);
  const slots: Slot[] = [];

  for (let d = 0; d < reglas.horizonte_dias; d++) {
    const fecha = sumarDias(hoy, d);
    if (!diaPermitido(reglas, fecha, hoy)) continue;
    const ocupDia = porDia.get(fecha) ?? [];
    const cupoRestante = reglas.cupo_diario - ocupDia.length;
    if (cupoRestante <= 0) continue;
    for (const hhmm of horas) {
      const inicio = localAUtc(fecha, hhmm, zona);
      const t = inicio.getTime();
      if (t < minimo || bloqueado(reglas, t)) continue;
      const fin = t + reglas.duracion_cita_min * MIN;
      const disponibles = Math.min(reglas.capacidad_por_slot - usadosEnSlot(reglas, ocupDia, t, fin), cupoRestante);
      if (disponibles <= 0) continue;
      slots.push({
        inicio: inicio.toISOString(),
        fin: new Date(fin).toISOString(),
        inicioLocal: isoLocalConOffset(inicio, zona),
        fecha,
        horaLocal: hhmm,
        capacidad: reglas.capacidad_por_slot,
        disponibles,
      });
    }
  }
  return slots;
}

export interface InicioValido { inicio: string; fin: string; fecha: string }

/** Valida que `inicio` sea un inicio ofrecible por las reglas (sin mirar la ocupación). */
export function validarInicio(reglas: ReglasAgenda, inicio: string, clock: Clock): Result<InicioValido, 'SLOT_INVALIDO'> {
  const t = Date.parse(inicio);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(inicio) || Number.isNaN(t) || t % MIN !== 0) return err('SLOT_INVALIDO');
  const ahora = clock.now();
  const zona = reglas.zona_horaria;
  const d = new Date(t);
  const fecha = fechaLocal(d, zona);
  if (!diaPermitido(reglas, fecha, fechaLocal(ahora, zona))) return err('SLOT_INVALIDO');
  if (!horasDeInicio(reglas).includes(horaLocal(d, zona))) return err('SLOT_INVALIDO');
  if (t < ahora.getTime() + reglas.antelacion_min_horas * 60 * MIN || bloqueado(reglas, t)) return err('SLOT_INVALIDO');
  return ok({ inicio: d.toISOString(), fin: new Date(t + reglas.duracion_cita_min * MIN).toISOString(), fecha });
}

/** C4–C8: ¿se puede reservar `inicio` con la ocupación actual de la vacante? */
export function puedeReservar(reglas: ReglasAgenda, ocupacion: Ocupacion, inicio: string, clock: Clock): Result<InicioValido, ErrorReserva> {
  const v = validarInicio(reglas, inicio, clock);
  if (!v.ok) return v;
  const ocupDia = indexar(reglas, ocupacion).get(v.value.fecha) ?? [];
  if (usadosEnSlot(reglas, ocupDia, Date.parse(v.value.inicio), Date.parse(v.value.fin)) >= reglas.capacidad_por_slot) return err('SLOT_LLENO');
  if (ocupDia.length >= reglas.cupo_diario) return err('CUPO_DIARIO');
  return v;
}
