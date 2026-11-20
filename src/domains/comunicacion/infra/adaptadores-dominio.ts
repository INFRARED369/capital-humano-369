/** Adaptadores hacia otros dominios (se inyectan sus funciones públicas para no acoplar imports). */
import type { SqlClient } from '@shared/sql.ts';
import type { ContactosPort, LinksGestionPort } from '../application/puertos.ts';

type ObtenerContactoLead = (sql: SqlClient, leadId: string) => Promise<{ telefonoE164: string; email: string | null; nombrePila: string; folio: string } | null>;

/** ContactosPort = captacion.obtenerContactoLead (null si el lead fue suprimido/anonimizado). */
export function crearContactosDesdeCaptacion(obtener: ObtenerContactoLead, sql: SqlClient): ContactosPort {
  return {
    async obtener(leadId) {
      const c = await obtener(sql, leadId);
      return c ? { telefonoE164: c.telefonoE164, email: c.email, nombrePila: c.nombrePila, folio: c.folio } : null;
    },
  };
}

type FirmarLinkGestion = (l: { citaId: string; accion: 'cancelar' | 'reprogramar'; expiraEn: string }, secreto: string) => Promise<string>;

/** LinksGestionPort = citas.firmarLinkGestion → URL pública `${baseUrl}/cita?t=<token>` (el token lleva la acción). */
export function crearLinksGestion(firmar: FirmarLinkGestion, secreto: string, baseUrl: string): LinksGestionPort {
  const base = baseUrl.replace(/\/+$/, '');
  return { firmar: async (i) => `${base}/cita?t=${encodeURIComponent(await firmar(i, secreto))}` };
}
