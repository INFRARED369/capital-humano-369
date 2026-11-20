/**
 * zoho-sync-worker (CIT-08): outbox → cola `zoho-sync` → Zoho Calendar.
 * Cron sugerido: cada minuto (pg_cron + pg_net, Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>).
 * Solo cableado: la lógica y sus pruebas viven en src/domains/citas/zoho.
 */
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { crearLogger } from '@shared/logger.ts';
import { systemClock } from '@shared/clock.ts';
import {
  crearDepsZohoSql, crearHandlerCronZoho, crearTokenCacheSql, crearZohoCalendarAdapter, ejecutarWorkerZoho, leerConfigZoho,
} from '@domains/citas/zoho/index.ts';

const { SUPABASE_DB_URL } = entornoDeno(['SUPABASE_DB_URL']);
const cfg = leerConfigZoho(Deno.env.toObject());
if (!cfg.ok) throw new Error(`Entorno inválido para zoho-sync-worker: ${cfg.error.join(', ')}`);

const logger = crearLogger({ funcion: 'zoho-sync-worker' });
const sql = sqlDeno(SUPABASE_DB_URL);
const calendario = crearZohoCalendarAdapter(cfg.value.zoho, {
  fetch, clock: systemClock, logger,
  // Token compartido entre isolates (cifrado en citas.zoho_token_cache): no agota el límite de tokens de Zoho.
  tokenCache: crearTokenCacheSql(sql, cfg.value.zoho.clientSecret),
});
const deps = crearDepsZohoSql({ sql, calendario, clock: systemClock, logger, panelUrl: cfg.value.panelUrl, zonaHoraria: cfg.value.zonaHoraria });

Deno.serve(crearHandlerCronZoho({
  nombre: 'zoho-sync-worker',
  secreto: cfg.value.secretoCron,
  logger,
  ejecutar: () => ejecutarWorkerZoho(deps, { lote: 20 }),
}));
