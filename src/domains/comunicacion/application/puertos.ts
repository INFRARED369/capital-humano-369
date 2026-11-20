/** Puertos del dominio Comunicación. Los adaptadores reales viven en infra/ o en otros dominios. */
import type { Result } from '@shared/result.ts';
import type { ReglasMensajes } from '../domain/plantillas.ts';

export type ErrorEnvio = { motivo: string; permanente: boolean; costoMxn?: number };
export type ResultadoEnvio = Result<{ proveedorId: string | null; costoMxn?: number }, ErrorEnvio>;

/** COM-01 · WhatsApp (Evolution API). */
export interface WhatsAppPort {
  readonly proveedor: string;
  enviarTexto(telefonoE164: string, texto: string): Promise<ResultadoEnvio>;
}

/** COM-08 · ¿El número existe en WhatsApp? (lo consume captación antes del OTP). */
export interface VerificadorWhatsAppPort {
  existeEnWhatsApp(telefonoE164: string): Promise<boolean>;
}

/** COM-01 · Correo (SMTP). */
export interface EmailPort {
  readonly proveedor: string;
  enviar(m: { para: string; asunto: string; texto: string }): Promise<ResultadoEnvio>;
}

/** COM-01 · SMS (NBX). Q-1: sin documentación del proveedor; adaptador genérico. */
export interface SmsPort {
  readonly proveedor: string;
  enviarSms(telefonoE164: string, texto: string): Promise<ResultadoEnvio>;
}

export interface Contacto {
  telefonoE164: string;
  email: string | null;
  nombrePila: string;
  folio: string;
}

/** Destino resuelto AL ENVIAR (implementación real: captacion.obtenerContactoLead). null = lead suprimido. */
export interface ContactosPort {
  obtener(leadId: string): Promise<Contacto | null>;
}

/** Reglas de mensajes vigentes de la vacante (config.reglas_vigentes → reglas.mensajes); si no hay, las por defecto. */
export interface ReglasVacantePort {
  obtener(vacanteId: string): Promise<{ reglas: ReglasMensajes; origen: string }>;
}

/** Links firmados de gestión de cita (implementación real: citas.firmarLinkGestion). */
export interface LinksGestionPort {
  firmar(i: { citaId: string; accion: 'cancelar' | 'reprogramar'; expiraEn: string }): Promise<string>;
}
