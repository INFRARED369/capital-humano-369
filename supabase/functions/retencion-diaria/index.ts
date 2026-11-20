/**
 * retencion-diaria (PRV-01, cron diario 03:00 America/Mexico_City programado en 00000000000001_plataforma.sql).
 * Llama a privacidad.retencion_diaria(now()): captación → citas (+zoho) → comunicación → tracking → ciclo de vida.
 * Autenticación: `Authorization: Bearer <RETENCION_SECRET | SUPABASE_SERVICE_ROLE_KEY>` (el cron usa la service key de Vault).
 * Solo cableado: la lógica y sus pruebas viven en src/domains/privacidad.
 */
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { systemClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerRetencion, crearRepoPrivacidadSql, ejecutarRetencionDiaria } from '@domains/privacidad/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL']);
const opc = Deno.env.toObject();
const secreto = opc.RETENCION_SECRET || opc.SUPABASE_SERVICE_ROLE_KEY || '';
if (!secreto) throw new Error('Entorno inválido para retencion-diaria: falta RETENCION_SECRET o SUPABASE_SERVICE_ROLE_KEY');

const log = crearLogger({ funcion: 'retencion-diaria' });
const sql = sqlDeno(env.SUPABASE_DB_URL);
const repo = crearRepoPrivacidadSql(sql);

Deno.serve(crearHandlerRetencion({
  secreto,
  log,
  ejecutar: () => ejecutarRetencionDiaria({ repo, clock: systemClock, logger: log }),
}));
