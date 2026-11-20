/**
 * API pública del dominio citas (src/CONTRATOS.md §citas). Ningún otro dominio importa archivos internos.
 */
import { systemClock, type Clock } from '@shared/clock.ts';
import type { Result } from '@shared/result.ts';
import type { SqlClient } from '@shared/sql.ts';
import {
  cancelarCitaCaso,
  confirmarCitaCaso,
  extenderRetencionCaso,
  liberarRetencionCaso,
  obtenerSlotsCaso,
  reprogramarCitaCaso,
  retenerSlotCaso,
  type EntradaConfirmacion,
  type EntradaRetencion,
  type ErrorConfirmacion,
  type ErrorExtension,
  type ErrorReprogramacion,
  type ErrorRetencion,
  type SlotsVacante,
} from './application/casosDeUso.ts';
import type { ContactosPort } from './application/puertos.ts';
import { crearRepoSql } from './infra/sqlCitasRepo.ts';
import { enTransaccion } from './infra/transaccion.ts';

export { ReglasAgendaSchema, PLANTILLA_AGENDA_DEFECTO, type ReglasAgenda } from './domain/reglas.ts';
export { generarSlots, puedeReservar, type Slot, type CitaActiva, type Ocupacion } from './domain/slots.ts';
export { ESTADOS_CITA, transicionar, type EstadoCita } from './domain/estados.ts';
export { firmarLinkGestion, verificarLinkGestion, type AccionGestion, type LinkGestion } from './domain/links.ts';
export type { ContactosPort } from './application/puertos.ts';
export type { ErrorConfirmacion, ErrorExtension, ErrorGestion, ErrorReprogramacion, ErrorRetencion } from './application/casosDeUso.ts';
export { RETENCION_MAX_TTLS } from './application/casosDeUso.ts';

export function obtenerSlots(deps: { sql: SqlClient; clock: Clock }, vacanteId: string): Promise<Result<SlotsVacante, 'VACANTE_NO_ENCONTRADA'>> {
  return obtenerSlotsCaso(crearRepoSql(deps.sql), deps.clock, vacanteId);
}

export function retenerSlot(tx: SqlClient, entrada: EntradaRetencion, clock: Clock) {
  return retenerSlotCaso(crearRepoSql(tx), entrada, clock);
}

/** Publica CitaConfirmada en la misma transacción. Idempotente si la cita ya estaba confirmada. */
export function confirmarCita(tx: SqlClient, entrada: EntradaConfirmacion, clock: Clock) {
  return confirmarCitaCaso(crearRepoSql(tx), entrada, clock);
}

/** Libera una retención (OTP fallido, lead descartado…). Idempotente; no toca citas confirmadas. */
export function liberarRetencion(tx: SqlClient, entrada: { citaId: string; motivo: string }, clock: Clock = systemClock): Promise<void> {
  return liberarRetencionCaso(crearRepoSql(tx), entrada, clock);
}

/**
 * Extiende una retención vigente (reenvío del OTP): expira = min(ahora + TTL, retención + RETENCION_MAX_TTLS × TTL);
 * nunca acorta. Vencida → EXPIRADA (y publica CitaExpirada); no retenida → TRANSICION_INVALIDA.
 */
export function extenderRetencion(tx: SqlClient, entrada: { citaId: string }, clock: Clock): Promise<Result<{ citaId: string; expiraEn: string }, ErrorExtension>> {
  return extenderRetencionCaso(crearRepoSql(tx), entrada, clock);
}

/** Publica CitaCancelada. `motivo` es un código [a-z0-9_] (texto libre se guarda como 'otro'). */
export function cancelarCita(tx: SqlClient, entrada: { citaId: string; motivo: string }, clock: Clock) {
  return cancelarCitaCaso(crearRepoSql(tx), entrada, clock);
}

/** Abre su propia transacción (se revierte completa si el nuevo slot no está disponible). Publica CitaReprogramada. */
export function reprogramarCita(
  sql: SqlClient,
  entrada: { citaId: string; nuevoInicio: string },
  deps: { contactos: ContactosPort; clock: Clock },
): Promise<Result<{ citaId: string; inicio: string; fin: string }, ErrorReprogramacion>> {
  return enTransaccion(sql, (tx) => reprogramarCitaCaso(crearRepoSql(tx), deps.contactos, entrada, deps.clock));
}

/** Implementación del AgendaPort que consume captación (postular / verificar-otp). */
export function crearAgendaPort(clock: Clock = systemClock) {
  return {
    retener: (tx: SqlClient, e: EntradaRetencion): Promise<Result<{ citaId: string; expiraEn: string; reglasVersion: number }, ErrorRetencion>> =>
      retenerSlot(tx, e, clock),
    confirmar: (tx: SqlClient, e: EntradaConfirmacion): Promise<Result<{ citaId: string; inicio: string; fin: string }, ErrorConfirmacion>> =>
      confirmarCita(tx, e, clock),
    liberar: (tx: SqlClient, e: { citaId: string; motivo: string }): Promise<void> => liberarRetencion(tx, e, clock),
    extender: (tx: SqlClient, e: { citaId: string }): Promise<Result<{ citaId: string; expiraEn: string }, ErrorExtension>> =>
      extenderRetencion(tx, e, clock),
  };
}

// Handlers HTTP (edge functions citas-api y gestionar-cita) — cableados en supabase/functions/<fn>/index.ts
export { crearHandlerCitasApi, type DepsCitasApi } from './infra/http/citasApi.ts';
export { crearHandlerGestionarCita, type DepsGestionarCita } from './infra/http/gestionarCita.ts';
export { crearLimitadorMemoria, type Limitador, type DecisionLimite } from './infra/http/limitador.ts';

// Subdominio Zoho Calendar (capa de acceso, CIT-08/CIT-09) y su fuente de verdad real (Z5).
export * from './zoho/index.ts';
export { crearCitasVigentesSql } from './infra/citasVigentesSql.ts';
