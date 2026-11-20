/** ContactosPort ← captacion.obtenerContactoLead (API pública de captación; se cablea en la edge function). */
import type { SqlClient } from '@shared/sql.ts';
import type { ContactosPort } from '../../application/puertos.ts';

export type ObtenerContactoLead = (sql: SqlClient, leadId: string) => Promise<{ telefonoE164: string; email: string | null; nombrePila: string } | null>;

export function crearContactosDesdeCaptacion(obtenerContactoLead: ObtenerContactoLead, sql: SqlClient): ContactosPort {
  return {
    async obtener(leadId) {
      const c = await obtenerContactoLead(sql, leadId);
      return c ? { telefonoE164: c.telefonoE164, email: c.email, nombrePila: c.nombrePila } : null;
    },
  };
}
