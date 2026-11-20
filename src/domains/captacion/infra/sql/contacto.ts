/** API pública: contacto del lead para enviar mensajes (lo usa comunicacion AL ENVIAR; CONTRATOS). */
import { UUID_RE } from '../../../../shared/ids.ts';
import type { SqlClient } from '../../../../shared/sql.ts';

export interface ContactoLead {
  /** E.164 sin '+' (p. ej. 528112345678), convención de @shared/crypto. */
  telefonoE164: string;
  email: string | null;
  nombrePila: string;
  folio: string;
  visitorId: string | null;
  vacanteId: string;
  clienteId: string;
}

/** Devuelve null si el lead no existe, fue suprimido o anonimizado: en ese caso NO se envía nada. */
export async function obtenerContactoLead(sql: SqlClient, leadId: string): Promise<ContactoLead | null> {
  if (!UUID_RE.test(leadId)) return null;
  const { rows } = await sql.query<{ telefono: string; email: string | null; nombre_pila: string; folio: string; visitor_id: string | null; vacante_id: string; cliente_id: string }>(
    `select telefono, email, nombre_pila, folio, visitor_id, vacante_id, cliente_id from captacion.leads
     where id = $1 and anonimizado_en is null and telefono is not null`,
    [leadId],
  );
  const r = rows[0];
  return r ? { telefonoE164: r.telefono, email: r.email, nombrePila: r.nombre_pila, folio: r.folio, visitorId: r.visitor_id, vacanteId: r.vacante_id, clienteId: r.cliente_id } : null;
}
