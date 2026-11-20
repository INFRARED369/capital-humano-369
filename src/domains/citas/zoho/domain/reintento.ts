/**
 * Política de reintento del zoho-sync-worker (CIT-08, Z3, NFR-DISP-01).
 * 1 intento + 2 reintentos (= max_intentos 3 de shared.cola) y luego dead letter con alerta.
 */
import type { ErrorCalendario } from './tipos.ts';

export const MAX_INTENTOS = 3;
const BASE_SEG = 30;
const TOPE_SEG = 900;

/** Backoff exponencial ×4 tras el intento n (1-based): 30 s, 120 s, 480 s… tope 15 min. */
export function backoffSegundos(intento: number): number {
  const n = Math.max(1, Math.floor(intento));
  return Math.min(TOPE_SEG, BASE_SEG * 4 ** (n - 1));
}

export function esReintentable(e: ErrorCalendario): boolean {
  return e.tipo === 'transitorio' || e.tipo === 'conflicto';
}
