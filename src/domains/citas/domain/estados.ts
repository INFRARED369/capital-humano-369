/** Ciclo de vida de la cita (CIT-07). La misma tabla se replica en SQL (citas.registrar_asistencia). */
import { err, ok, type Result } from '@shared/result.ts';

export const ESTADOS_CITA = ['retenida', 'confirmada', 'asistio', 'no_asistio', 'cancelada', 'reprogramada', 'expirada'] as const;
export type EstadoCita = (typeof ESTADOS_CITA)[number];

export type AccionCita = 'confirmar' | 'expirar' | 'liberar' | 'marcar_asistio' | 'marcar_no_asistio' | 'cancelar' | 'reprogramar';

/** Estados que ocupan capacidad. */
export const ESTADOS_ACTIVOS: readonly EstadoCita[] = ['retenida', 'confirmada'];

const TRANSICIONES: Readonly<Record<EstadoCita, Partial<Record<AccionCita, EstadoCita>>>> = {
  retenida: { confirmar: 'confirmada', expirar: 'expirada', liberar: 'expirada' },
  confirmada: { marcar_asistio: 'asistio', marcar_no_asistio: 'no_asistio', cancelar: 'cancelada', reprogramar: 'reprogramada' },
  asistio: {},
  no_asistio: {},
  cancelada: {},
  reprogramada: {},
  expirada: {},
};

export function transicionar(estado: EstadoCita, accion: AccionCita): Result<EstadoCita, 'TRANSICION_INVALIDA'> {
  const destino = TRANSICIONES[estado][accion];
  return destino ? ok(destino) : err('TRANSICION_INVALIDA');
}

export const esTerminal = (e: EstadoCita): boolean => Object.keys(TRANSICIONES[e]).length === 0;
