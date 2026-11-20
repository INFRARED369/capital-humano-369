/** Reglas puras del lead: folio, nombre de pila y deduplicación (CAP-06, CAP-07). */
import { randomBytes, randomInt } from '../../../shared/ids.ts';

// Sin 0/O ni 1/I para dictarlo por teléfono sin ambigüedad. 32 símbolos ^ 6 ≈ 1.07e9 combinaciones.
const ALFABETO_FOLIO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const FOLIO_RE = /^369-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/** Folio legible generado en el servidor; la unicidad la garantiza la BD (reintento ante colisión). */
export function generarFolio(random: (n: number) => Uint8Array = randomBytes): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALFABETO_FOLIO[randomInt(ALFABETO_FOLIO.length, random)];
  return `369-${s}`;
}

export function nombrePila(nombre: string): string {
  const primero = nombre.trim().split(/\s+/)[0] ?? '';
  return primero.charAt(0).toLocaleUpperCase('es-MX') + primero.slice(1).toLocaleLowerCase('es-MX');
}

export const VENTANA_DEDUPE_DIAS = 30;

export function inicioVentanaDedupe(ahora: Date): Date {
  return new Date(ahora.getTime() - VENTANA_DEDUPE_DIAS * 86_400_000);
}

export type EstadoLead = 'pendiente_otp' | 'verificado' | 'otp_bloqueado';

export type DecisionDedupe = { accion: 'crear' } | { accion: 'reutilizar'; leadId: string } | { accion: 'ya_postulado'; leadId: string };

/**
 * P5: mismo teléfono (HMAC) + misma vacante dentro de 30 días → se reutiliza el lead (mismo folio,
 * sin un nuevo `LeadCreado`). Si ya verificó su WhatsApp y tiene cita confirmada, no se crea otra.
 */
export function decidirDedupe(existente: { id: string; estado: EstadoLead } | null): DecisionDedupe {
  if (!existente) return { accion: 'crear' };
  if (existente.estado === 'verificado') return { accion: 'ya_postulado', leadId: existente.id };
  return { accion: 'reutilizar', leadId: existente.id };
}
