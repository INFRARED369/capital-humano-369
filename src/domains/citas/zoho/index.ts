/**
 * API pública del subdominio citas/zoho (Zoho Calendar como capa de acceso, D8/D9).
 * El orquestador la re-exporta desde src/domains/citas/index.ts.
 */
export { construirEventoMinimo, uidPropioDe, nombrePilaSeguro, normalizarCalendarUid, type EventoCalendario, type ConfigEvento } from './domain/evento.ts';
export { decidirReconciliacion, type AccionReconciliacion } from './domain/reconciliacion.ts';
export { MAX_INTENTOS as ZOHO_MAX_INTENTOS, backoffSegundos as zohoBackoffSegundos } from './domain/reintento.ts';
export type { EventoRemoto, ErrorCalendario, TipoAlertaZoho } from './domain/tipos.ts';
export type {
  CalendarioExternoPort, CitasVigentesPort, CitaVigente, RangoFechas, RegistroZoho, DepsWorker, DepsReconciliacion,
} from './application/puertos.ts';
export { ejecutarWorkerZoho, COLA_ZOHO, CONSUMIDOR_ZOHO, type ResumenWorker } from './application/worker.ts';
export { reconciliarZoho, type ResumenReconciliacion } from './application/reconciliar.ts';
export { crearZohoCalendarAdapter, dominiosZoho, type ZohoConfig, type TokenCachePort } from './infra/zohoCalendarAdapter.ts';
export { crearTokenCacheSql } from './infra/zohoTokenCache.ts';
export { crearDepsZohoSql, crearDepsReconciliacionSql, crearCitasVigentesDesdeZohoSql } from './infra/sqlZoho.ts';
export { crearHandlerCronZoho, leerConfigZoho, verificarBearer, type ConfigZohoEntorno } from './infra/http/handlers.ts';
