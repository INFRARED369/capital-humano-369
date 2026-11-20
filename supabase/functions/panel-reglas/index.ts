/**
 * Edge function panel-reglas — POST { operacion, datos } con la sesión del panel (Bearer de Supabase Auth).
 * DSH-04, NFR-ESC-06, S3, S4. Solo cableado; la lógica y sus pruebas viven en
 * src/domains/vacantes/infra/http/panelReglas.ts (+ application/casosDeUso.ts).
 * SUPABASE_ANON_KEY la inyecta el runtime de Supabase (no es secreto); se lee aparte porque no está en el
 * esquema de _shared/env.ts.
 */
import { consumirCupo, entornoDeno, llaveRateLimit, servir, sqlDeno } from '../_shared/index.ts';
import { crearHandlerPanelReglas, crearRepoReglasSql, crearVerificadorSupabaseAuth } from '@domains/vacantes/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'SUPABASE_URL', 'HMAC_PEPPER', 'ALLOWED_ORIGIN']);
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
if (!anonKey) throw new Error('Entorno inválido (SUPABASE_ANON_KEY): falta');
const sql = sqlDeno(env.SUPABASE_DB_URL);

const handler = crearHandlerPanelReglas({
  repo: crearRepoReglasSql(sql),
  sesion: crearVerificadorSupabaseAuth({ url: env.SUPABASE_URL, anonKey }),
  allowedOrigin: env.ALLOWED_ORIGIN,
  limitador: {
    async permitir(usuarioId: string) {
      const c = await consumirCupo(sql, { llave: await llaveRateLimit(env.HMAC_PEPPER, 'panel-reglas', usuarioId), limite: 60, ventanaSeg: 600 });
      return { ok: c.permitido, reintentarEnSeg: c.reintentarEnSeg };
    },
  },
});

Deno.serve(servir((req) => handler(req), { funcion: 'panel-reglas', origenes: env.ALLOWED_ORIGIN }));
