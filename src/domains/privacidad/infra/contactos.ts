/**
 * ContactosPort sobre la API pública de captación (`obtenerContactoLead`), inyectada desde la raíz de
 * composición (supabase/functions/arco). El teléfono solo vive en memoria para calcular el HMAC.
 */
import type { SqlClient } from '@shared/sql.ts';
import type { ContactosPort } from '../application/puertos.ts';

export type ObtenerContactoLead = (sql: SqlClient, leadId: string) => Promise<{ telefonoE164: string } | null>;

export function crearContactosDesdeCaptacion(obtener: ObtenerContactoLead, sql: SqlClient): ContactosPort {
  return {
    async telefonoDeLead(leadId) {
      return (await obtener(sql, leadId))?.telefonoE164 ?? null;
    },
  };
}
