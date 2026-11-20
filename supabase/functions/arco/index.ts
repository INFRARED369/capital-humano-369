/**
 * arco (PRV-02): registrar / ejecutar / responder / consultar / listar solicitudes ARCO y revocaciones.
 * Solo un admin del panel con JWT de Supabase Auth verificado contra /auth/v1/user (y MFA aal2, salvo
 * ARCO_REQUIERE_MFA=false), o la service key. El teléfono del titular solo vive en memoria: se guarda su HMAC.
 * Entorno: SUPABASE_DB_URL, SUPABASE_URL, HMAC_PEPPER, ALLOWED_ORIGIN (origen del panel), SUPABASE_SERVICE_ROLE_KEY,
 * SUPABASE_ANON_KEY; opcionales ARCO_REQUIERE_MFA y ARCO_DIAS_INHABILES (YYYY-MM-DD separados por comas).
 */
import { entornoDeno, servir, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { obtenerContactoLead } from '@domains/captacion/index.ts';
import {
  crearAutenticadorArco, crearContactosDesdeCaptacion, crearEsAdminSql, crearHandlerArco, crearRepoPrivacidadSql, crearVerificadorSupabase,
} from '@domains/privacidad/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'SUPABASE_URL', 'HMAC_PEPPER', 'ALLOWED_ORIGIN']);
const opc = Deno.env.toObject();
const serviceKey = opc.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = opc.SUPABASE_ANON_KEY ?? '';
if (!serviceKey || !anonKey) throw new Error('Entorno inválido para arco: faltan SUPABASE_SERVICE_ROLE_KEY o SUPABASE_ANON_KEY');
const inhabiles = (opc.ARCO_DIAS_INHABILES ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));

const sql = sqlDeno(env.SUPABASE_DB_URL);
const autenticar = crearAutenticadorArco({
  serviceKey,
  verificarToken: crearVerificadorSupabase({ url: env.SUPABASE_URL, apiKey: anonKey, fetch }),
  esAdmin: crearEsAdminSql(sql),
  requiereMfa: opc.ARCO_REQUIERE_MFA !== 'false',
});

Deno.serve(servir(
  (req, ctx) => crearHandlerArco({
    autenticar,
    log: ctx.log,
    privacidad: {
      repo: crearRepoPrivacidadSql(sql),
      contactos: crearContactosDesdeCaptacion(obtenerContactoLead, sql),
      clock: systemClock,
      logger: ctx.log,
      pepper: env.HMAC_PEPPER,
      inhabiles,
    },
  })(req),
  { funcion: 'arco', origenes: env.ALLOWED_ORIGIN },
));
