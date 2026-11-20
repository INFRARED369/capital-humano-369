import type { SqlClient } from '@shared/sql.ts';
import { uuidv7 } from '@shared/ids.ts';
import { POLITICA_DEFECTO } from '../domain/reintento.ts';
import { prioridadDe, SolicitudMensajeSchema, type SolicitudMensaje } from '../domain/tipos.ts';
import { insertarYEncolar } from './repositorio.ts';

/**
 * COM-04 · Encola un mensaje de forma idempotente (misma llave → mismo mensaje).
 * Llamar dentro de la transacción del cambio de negocio. OTP → prioridad 0 (M9).
 * La cola solo lleva el id; el destino se resuelve al enviar.
 */
export async function encolarMensaje(tx: SqlClient, solicitud: SolicitudMensaje): Promise<{ mensajeId: string }> {
  const s = SolicitudMensajeSchema.parse(solicitud);
  const mensajeId = await insertarYEncolar(tx, {
    id: uuidv7(),
    clienteId: s.clienteId,
    vacanteId: s.vacanteId,
    leadId: s.leadId,
    citaId: s.citaId ?? null,
    tipo: s.tipo,
    canal: s.canal,
    llave: s.llave,
    prioridad: prioridadDe(s.tipo),
    programadoPara: s.programadoPara ?? null,
    variables: s.variables && Object.keys(s.variables).length ? s.variables : null,
    codigoCifrado: s.codigoCifrado ?? null,
    correlationId: s.correlationId ?? null,
    maxIntentos: POLITICA_DEFECTO.maxIntentos,
  });
  return { mensajeId };
}
