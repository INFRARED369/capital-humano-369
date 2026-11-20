/** API pública del dominio observabilidad (NFR-OBS-01: alertas automáticas). */
export { TIPOS_ALERTA, formatearAlertas, payloadWebhook, sanearDetalle, type Alerta, type Severidad, type TipoAlerta } from './domain/alertas.ts';
export { ejecutarAlertas, type DepsAlertas, type NotificadorAlertasPort, type RepoAlertasPort, type ResumenAlertas } from './application/ejecutar.ts';
export { crearNotificadorEmail, crearNotificadorWebhook, destinatariosAlertas } from './infra/notificadores.ts';
export { crearRepoAlertasSql } from './infra/sql.ts';
export { crearHandlerAlertas } from './infra/http/handler.ts';
