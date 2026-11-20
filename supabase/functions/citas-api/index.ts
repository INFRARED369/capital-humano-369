/**
 * Edge function citas-api — GET ?vacante=<slug|uuid>. Solo cableado; la lógica y sus pruebas
 * viven en src/domains/citas/infra/http/citasApi.ts.
 */
import { consumirCupo, entornoDeno, llaveRateLimit, servir, sqlDeno } from '../_shared/index.ts';
import { crearHandlerCitasApi } from '@domains/citas/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'HMAC_PEPPER', 'ALLOWED_ORIGIN']);
const sql = sqlDeno(env.SUPABASE_DB_URL);

const handler = crearHandlerCitasApi({
  sql,
  allowedOrigin: env.ALLOWED_ORIGIN,
  // Rate limit global en BD (llaves HMAC, sin IP en claro): 60 consultas por minuto por IP.
  limitador: {
    async permitir(ip: string) {
      const c = await consumirCupo(sql, { llave: await llaveRateLimit(env.HMAC_PEPPER, 'citas-slots', ip), limite: 60, ventanaSeg: 60 });
      return { ok: c.permitido, reintentarEnSeg: c.reintentarEnSeg };
    },
  },
});

Deno.serve(servir((req) => handler(req), { funcion: 'citas-api', origenes: env.ALLOWED_ORIGIN }));
