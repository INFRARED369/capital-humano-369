/**
 * Edge function gestionar-cita — POST { token, operacion?, nuevo_inicio? } con link firmado (CIT-11, C15).
 * Solo cableado; la lógica y sus pruebas viven en src/domains/citas/infra/http/gestionarCita.ts.
 */
import { consumirCupo, entornoDeno, llaveRateLimit, servir, sqlDeno } from '../_shared/index.ts';
import { crearHandlerGestionarCita } from '@domains/citas/index.ts';
import { obtenerContactoLead } from '@domains/captacion/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'LINKS_SECRET', 'ALLOWED_ORIGIN']);
const sql = sqlDeno(env.SUPABASE_DB_URL);

const handler = crearHandlerGestionarCita({
  sql,
  allowedOrigin: env.ALLOWED_ORIGIN,
  secreto: env.LINKS_SECRET,
  // Puerto ContactosPort ← captacion.obtenerContactoLead (solo folio y nombre de pila para CitaReprogramada).
  contactos: {
    async datosCita(leadId: string) {
      const c = await obtenerContactoLead(sql, leadId);
      return c ? { folio: c.folio, nombrePila: c.nombrePila } : null;
    },
  },
  limitador: {
    async permitir(ip: string) {
      const c = await consumirCupo(sql, { llave: await llaveRateLimit(env.HMAC_PEPPER, 'citas-gestion', ip), limite: 20, ventanaSeg: 600 });
      return { ok: c.permitido, reintentarEnSeg: c.reintentarEnSeg };
    },
  },
});

Deno.serve(servir((req) => handler(req), { funcion: 'gestionar-cita', origenes: env.ALLOWED_ORIGIN }));
