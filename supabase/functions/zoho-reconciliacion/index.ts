/**
 * zoho-reconciliacion (CIT-09, Z5): cada 15 min; el sistema gana y registra ZOHO_DRIFT.
 * La fuente de verdad (Z5) son las citas confirmadas de citas.citas (crearCitasVigentesSql).
 */
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { crearLogger } from '@shared/logger.ts';
import { systemClock } from '@shared/clock.ts';
import {
  crearCitasVigentesSql, crearDepsReconciliacionSql, crearHandlerCronZoho, crearTokenCacheSql, crearZohoCalendarAdapter, leerConfigZoho, reconciliarZoho,
} from '@domains/citas/index.ts';

const { SUPABASE_DB_URL } = entornoDeno(['SUPABASE_DB_URL']);
const cfg = leerConfigZoho(Deno.env.toObject());
if (!cfg.ok) throw new Error(`Entorno inválido para zoho-reconciliacion: ${cfg.error.join(', ')}`);

const logger = crearLogger({ funcion: 'zoho-reconciliacion' });
const sql = sqlDeno(SUPABASE_DB_URL);
const calendario = crearZohoCalendarAdapter(cfg.value.zoho, {
  fetch, clock: systemClock, logger,
  // Token compartido entre isolates (cifrado en citas.zoho_token_cache): no agota el límite de tokens de Zoho.
  tokenCache: crearTokenCacheSql(sql, cfg.value.zoho.clientSecret),
});
const deps = crearDepsReconciliacionSql({ sql, calendario, clock: systemClock, logger, panelUrl: cfg.value.panelUrl, zonaHoraria: cfg.value.zonaHoraria, citasVigentes: crearCitasVigentesSql(sql) });

Deno.serve(crearHandlerCronZoho({
  nombre: 'zoho-reconciliacion',
  secreto: cfg.value.secretoCron,
  logger,
  ejecutar: () => reconciliarZoho(deps, { horizonteDias: 30 }),
}));
