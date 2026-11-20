/**
 * Máquina de estados del flujo del candidato: datos → horario → OTP → pase (o fallback a WhatsApp).
 * F7.4: si la vacante agenda por WhatsApp, datos → 'whatsapp' (sin horario ni OTP).
 * El código de verificación puede ir por WhatsApp, SMS o correo; el candidato puede cambiar de canal al reenviar.
 */
export type CanalOtp = 'whatsapp' | 'sms' | 'email';
export const CANALES_OTP: readonly CanalOtp[] = ['whatsapp', 'sms', 'email'];
export const ETIQUETA_CANAL: Record<CanalOtp, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'correo' };

/** Teléfono de 10 dígitos legible: +52 81 1234 5678. */
export function formatearTelefono(telefono: string): string {
  const d = telefono.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `+52 ${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}` : telefono.trim();
}

/** A dónde llega el código según el canal (siempre visible para el candidato). Null si falta el correo. */
export function destinoOtp(canal: CanalOtp, telefono: string, email: string): string | null {
  if (canal === 'email') return email.trim() ? email.trim().toLowerCase() : null;
  return formatearTelefono(telefono);
}

export type Paso = 'formulario' | 'horario' | 'whatsapp' | 'otp' | 'pase' | 'fallback';

export interface EstadoFlujo {
  paso: Paso;
  leadId: string | null;
  folio: string | null;
  expiraEn: string | null;
  reenviosRestantes: number;
  /** Canal por el que se envió el último código. */
  canal: CanalOtp;
  citaInicio: string | null;
  aviso: string | null;
}

export type Accion =
  | { tipo: 'datos_listos' }
  | { tipo: 'agenda_whatsapp' }
  | { tipo: 'postulado'; leadId: string; folio: string; expiraEn: string; reenviosRestantes: number; canal: CanalOtp }
  | { tipo: 'reenviado'; expiraEn: string; reenviosRestantes: number; canal: CanalOtp }
  | { tipo: 'verificado'; inicio: string; fin: string }
  | { tipo: 'elegir_otro_horario'; mensaje: string }
  | { tipo: 'fallback' }
  | { tipo: 'volver' }
  /** Avance recuperado del navegador tras recargar (persistencia.ts). */
  | { tipo: 'restaurar'; estado: EstadoFlujo };

export const estadoInicial: EstadoFlujo = { paso: 'formulario', leadId: null, folio: null, expiraEn: null, reenviosRestantes: 0, canal: 'whatsapp', citaInicio: null, aviso: null };

export function reducir(s: EstadoFlujo, a: Accion): EstadoFlujo {
  switch (a.tipo) {
    case 'datos_listos': return { ...s, paso: 'horario', aviso: null };
    case 'agenda_whatsapp': return { ...s, paso: 'whatsapp', aviso: null };
    case 'postulado': return { ...s, paso: 'otp', leadId: a.leadId, folio: a.folio, expiraEn: a.expiraEn, reenviosRestantes: a.reenviosRestantes, canal: a.canal, aviso: null };
    case 'reenviado': return { ...s, expiraEn: a.expiraEn, reenviosRestantes: a.reenviosRestantes, canal: a.canal };
    case 'verificado': return { ...s, paso: 'pase', citaInicio: a.inicio, aviso: null };
    case 'elegir_otro_horario': return { ...s, paso: 'horario', aviso: a.mensaje };
    case 'fallback': return { ...s, paso: 'fallback' };
    case 'volver': return { ...s, paso: 'formulario', aviso: null };
    case 'restaurar': return { ...a.estado };
  }
}

const MENSAJES: Record<string, string | ((c: Record<string, unknown>) => string)> = {
  FORMATO_INVALIDO: 'Revisa los campos marcados.',
  CONSENTIMIENTO_REQUERIDO: 'Para continuar acepta el Aviso de Privacidad.',
  ANTIBOT_REQUERIDO: 'Completa la verificación de seguridad.',
  ANTIBOT_INVALIDO: 'No pudimos validar la verificación de seguridad. Intenta de nuevo.',
  WHATSAPP_INVALIDO: 'Ese número no tiene WhatsApp. Elige recibir el código por SMS o por correo, o corrige tu número.',
  CANAL_NO_DISPONIBLE: 'Ese medio no está disponible por ahora. Elige otro para recibir tu código.',
  EMAIL_REQUERIDO: 'Escribe tu correo para recibir el código.',
  LIMITE_TELEFONO: 'Pediste demasiados códigos (cuentan todos los medios). Espera una hora o escríbenos por WhatsApp.',
  LIMITE_IP: 'Demasiados intentos desde esta conexión. Espera una hora o escríbenos por WhatsApp.',
  SLOT_LLENO: 'Ese horario se acaba de ocupar. Elige otro.',
  CUPO_DIARIO: 'Ese día ya está lleno. Elige otro día.',
  SLOT_INVALIDO: 'Ese horario ya no está disponible. Elige otro.',
  RETENCION_EXPIRADA: 'Tu horario expiró mientras verificabas. Elige uno nuevo.',
  YA_POSTULADO: 'Ya tienes una entrevista agendada para esta vacante.',
  OTP_INCORRECTO: (c) => `Código incorrecto. Te quedan ${String(c.intentos_restantes ?? '')} intentos.`,
  OTP_VENCIDO: (c) => (c.puede_reenviar ? 'El código venció. Pide uno nuevo.' : 'El código venció y alcanzaste el límite de reenvíos. Escríbenos por WhatsApp.'),
  OTP_BLOQUEADO: 'Bloqueamos la verificación por demasiados intentos y liberamos tu horario. Vuelve a postularte o escríbenos por WhatsApp.',
  YA_VERIFICADO: 'Tu registro ya estaba verificado.',
  NO_ENCONTRADO: 'Tu registro ya no está disponible. Vuelve a postularte.',
  VACANTE_NO_ENCONTRADA: 'Esta vacante no está disponible en este momento.',
};

export function mensajeError(codigo: string, cuerpo: Record<string, unknown> = {}): string {
  const m = MENSAJES[codigo];
  if (!m) return 'Algo salió mal. Intenta de nuevo o escríbenos por WhatsApp.';
  return typeof m === 'function' ? m(cuerpo) : m;
}
