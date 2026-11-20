/**
 * API pública del dominio transversal Privacidad (PRV-01..03, Política de retención de datos).
 * SQL público: privacidad.retencion_diaria, privacidad.suprimir_lead(uuid[, hmac]), privacidad.retencion_aplicar,
 * privacidad.arco_* (solo service_role) y privacidad.api_lead_bloqueado(uuid) (panel).
 */
export { DOMINIOS_RETENCION, esSoloConteos, sumarConteos, totalConteos, validarRegistro, type Conteos, type DominioRetencion } from './domain/registro.ts';
export { calcularPlazos, estadoEn, etapaTrasEvento, ETAPAS, PLAZOS_POLITICA, type Etapa, type Plazos } from './domain/ciclo-vida.ts';
export { esDiaHabil, festivosMexico, plazosArco, sumarDiasHabiles, PLAZO_RESPUESTA_DIAS_HABILES, PLAZO_EJECUCION_DIAS_HABILES } from './domain/plazos.ts';
export { TIPOS_ARCO, ESTADOS_ARCO, CANALES_ARCO, requiereSupresion, transicionArco, vencimiento, type TipoArco, type EstadoArco, type CanalArco } from './domain/arco.ts';
export type { DepsPrivacidad, PrivacidadRepo, ContactosPort, ResumenRetencion, SolicitudArco } from './application/puertos.ts';
export { ejecutarRetencionDiaria } from './application/retencion.ts';
export { registrarSolicitudArco, ejecutarSolicitudArco, responderSolicitudArco, consultarSolicitudArco, listarSolicitudesArco } from './application/arco.ts';
export { crearRepoPrivacidadSql } from './infra/sql/repo.ts';
export { crearContactosDesdeCaptacion, type ObtenerContactoLead } from './infra/contactos.ts';
export { crearHandlerRetencion, type DepsHandlerRetencion } from './infra/http/retencion.ts';
export { crearHandlerArco, type DepsHandlerArco } from './infra/http/arco.ts';
export { crearAutenticadorArco, crearVerificadorSupabase, crearEsAdminSql, claimDe, type Autenticado, type FallaAuth } from './infra/http/autenticacion.ts';
