/**
 * API pública del dominio Captación (CONTRATOS). Otros dominios y la app web SOLO importan desde aquí.
 * Los handlers HTTP (infra/http) los importa directamente supabase/functions/<fn>/index.ts.
 */
export { obtenerContactoLead, type ContactoLead } from './infra/sql/contacto.ts';
export { hmacTelefono } from './application/comun.ts';
export type { AgendaPort, MensajeriaPort, VerificadorWhatsAppPort, AntiBotPort, SolicitudMensaje } from './application/puertos.ts';

// Contenido y formulario (compartido con el navegador para validar antes de enviar).
export { ContenidoVacanteSchema, type ContenidoVacante } from './domain/contenido.ts';
export { construirEsquemaPostulacion, validarPostulacion, PreguntasSchema, AtribucionSchema, type Pregunta, type PreguntaNormalizada, type Atribucion } from './domain/formulario.ts';
export { ContactoB2BSchema, SERVICIOS_B2B, validarContactoB2B } from './domain/b2b.ts';
export { OTP, CANALES_OTP, type CanalOtp } from './domain/otp.ts';
export { FOLIO_RE } from './domain/lead.ts';
