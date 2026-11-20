/** API pública del dominio Comunicación (CONTRATOS.md §comunicacion). */
export { TIPOS_MENSAJE, CANALES, prioridadDe, SolicitudMensajeSchema, type TipoMensaje, type Canal, type SolicitudMensaje } from './domain/tipos.ts';
export { ReglasMensajesSchema, PLANTILLAS_DEFECTO, VARIABLES_PERMITIDAS, renderPlantilla, type ReglasMensajes, type Plantilla } from './domain/plantillas.ts';
export { crearPoliticaReintento, POLITICA_DEFECTO, type PoliticaReintento } from './domain/reintento.ts';
export { cifrarCodigoOtp, descifrarCodigoOtp } from './domain/otp.ts';
export { firmarWebhook, verificarWebhook, verificarTokenWebhook, verificarFrescura, idEventoEvolution } from './domain/webhook.ts';
export { encolarMensaje } from './application/encolar.ts';
export { registrarOptOut, hmacTelefono, normalizarTelefono, type SolicitudOptOut } from './application/privacidad.ts';
export { procesarLote, type DepsWorker, type ResumenLote } from './application/worker.ts';
export type {
  WhatsAppPort,
  VerificadorWhatsAppPort,
  EmailPort,
  SmsPort,
  ContactosPort,
  Contacto,
  ReglasVacantePort,
  LinksGestionPort,
  ResultadoEnvio,
  ErrorEnvio,
} from './application/puertos.ts';
export { crearReglasVacanteSql } from './infra/reglas-sql.ts';
export { procesarEventosCitas, CONSUMIDOR, TIPOS_SUSCRITOS, type DepsSuscriptores, type ResumenSuscriptores } from './application/suscriptores.ts';
export { correrTrabajoComunicacion, type DepsTrabajo, type ResumenTrabajo } from './application/trabajo.ts';
export { crearEvolutionAdapter, EvolutionSendTextSchema, EvolutionWhatsappNumbersSchema, type EvolutionConfig } from './infra/evolution.ts';
export { crearNbxSmsAdapter, type NbxConfig } from './infra/nbx.ts';
export { crearEmailSmtpAdapter, type TransporteSmtp } from './infra/email.ts';
export { crearContactosDesdeCaptacion, crearLinksGestion } from './infra/adaptadores-dominio.ts';
export { crearHandlerWebhook, type DepsWebhook, type ProveedorWebhook } from './infra/http/webhooks.ts';
export { crearHandlerWorker, type DepsHandlerWorker } from './infra/http/worker.ts';
