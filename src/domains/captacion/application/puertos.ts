/**
 * Puertos que consume Captación. Los implementan otros dominios (citas, comunicacion) o adaptadores
 * de infraestructura (Turnstile, SQL) y se cablean en supabase/functions/{postular,verificar-otp,contacto-b2b}.
 */
import type { Clock } from '../../../shared/clock.ts';
import type { Logger } from '../../../shared/logger.ts';
import type { Result } from '../../../shared/result.ts';
import type { SqlClient } from '../../../shared/sql.ts';
import type { EstadoLead } from '../domain/lead.ts';
import type { CanalOtp, EstadoOtpNombre } from '../domain/otp.ts';
import type { Pregunta } from '../domain/formulario.ts';

/** = dominio citas (retenerSlot / confirmarCita / liberarRetencion). Todas corren en la transacción `tx`. */
export interface AgendaPort {
  retener(tx: SqlClient, i: { vacanteId: string; leadId: string; inicio: string }): Promise<Result<{ citaId: string; expiraEn: string; reglasVersion: number }, 'SLOT_INVALIDO' | 'SLOT_LLENO' | 'CUPO_DIARIO' | 'VACANTE_NO_ENCONTRADA'>>;
  confirmar(tx: SqlClient, i: { citaId: string; folio: string; nombrePila: string; eventId: string }): Promise<Result<{ citaId: string; inicio: string; fin: string }, 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA'>>;
  liberar(tx: SqlClient, i: { citaId: string; motivo: string }): Promise<void>;
  /** Reenvío del OTP: renueva la retención del slot (citas.extenderRetencion; con tope, nunca acorta). */
  extender(tx: SqlClient, i: { citaId: string }): Promise<Result<{ citaId: string; expiraEn: string }, 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA'>>;
}

/** Estructuralmente igual a `SolicitudMensaje` de comunicacion (CONTRATOS). La cola no guarda PII en claro. */
export interface SolicitudMensaje {
  tipo: 'otp' | 'confirmacion' | 'recordatorio_24h' | 'recordatorio_2h' | 'cancelacion' | 'reprogramacion' | 'agradecimiento';
  canal: 'whatsapp' | 'email' | 'sms';
  leadId: string;
  vacanteId: string;
  clienteId: string;
  llave: string;
  variables?: Record<string, string>;
  programadoPara?: string;
  codigoCifrado?: string;
}

/** = comunicacion.encolarMensaje (OTP → prioridad 0). */
export interface MensajeriaPort {
  encolar(tx: SqlClient, s: SolicitudMensaje): Promise<{ mensajeId: string }>;
}

/** = comunicacion (Evolution): el número existe en WhatsApp (P7, COM-08). Lanza si el proveedor no responde. */
export interface VerificadorWhatsAppPort {
  existeEnWhatsApp(telefonoE164: string): Promise<boolean>;
}

/** Anti-bot (Turnstile) verificado en el servidor. Lanza si el proveedor no responde. */
export interface AntiBotPort {
  verificar(token: string, ip: string | null): Promise<boolean>;
}

/** Preguntas del formulario por slug (contenido JSON de la vacante). */
export interface FormulariosPort {
  preguntas(slug: string): Pregunta[] | null;
}

export interface LeadParaVerificar {
  id: string;
  clienteId: string;
  vacanteId: string;
  folio: string;
  nombrePila: string;
  telefonoHmac: string;
  estado: EstadoLead;
  citaId: string | null;
  citaInicio: string | null;
  /** Si el lead tiene correo guardado (para enviar el código por email). */
  tieneEmail: boolean;
}

export interface OtpGuardado {
  id: string;
  codigoHash: string;
  expiraEn: Date;
  intentos: number;
  estado: EstadoOtpNombre;
}

export interface DatosLead {
  nombre: string;
  nombrePila: string;
  telefonoE164: string;
  telefonoHmac: string;
  email: string | null;
  respuestas: Record<string, string | number>;
  consentimientoVersion: string;
  atribucion: Record<string, string>;
  visitorId: string | null;
}

/** Repositorio de captación ligado a una conexión o transacción. */
export interface CaptacionRepo {
  buscarVacante(slug: string): Promise<{ id: string; clienteId: string } | null>;
  contarEnvios(tipo: 'otp' | 'b2b', f: { telefonoHmac: string | null; ipHmac: string | null; desde: Date }): Promise<{ porTelefono: number; porIp: number }>;
  bloquearTelefono(vacanteId: string, telefonoHmac: string): Promise<void>;
  buscarLeadDedupe(vacanteId: string, telefonoHmac: string, eventId: string, desde: Date): Promise<LeadParaVerificar | null>;
  existeEventId(eventId: string): Promise<boolean>;
  insertarLead(i: DatosLead & { clienteId: string; vacanteId: string; folio: string; eventId: string; ahora: Date }): Promise<string | null>;
  reutilizarLead(id: string, d: DatosLead, ahora: Date): Promise<void>;
  asignarCita(leadId: string, citaId: string | null, citaInicio: string | null, ahora: Date): Promise<void>;
  obtenerLead(leadId: string): Promise<LeadParaVerificar | null>;
  marcarLead(leadId: string, estado: EstadoLead, ahora: Date): Promise<void>;
  /** El candidato pide el código por correo y escribe (o corrige) su email en el paso de verificación. */
  actualizarEmail(leadId: string, email: string, ahora: Date): Promise<void>;
  cerrarOtpVigente(leadId: string, estado: 'reemplazado', ahora: Date): Promise<void>;
  insertarOtp(i: { id: string; clienteId: string; leadId: string; codigoHash: string; expiraEn: Date; ahora: Date }): Promise<void>;
  ultimoOtp(leadId: string): Promise<OtpGuardado | null>;
  actualizarOtp(id: string, c: { intentos: number; estado: EstadoOtpNombre; ahora: Date }): Promise<void>;
  registrarEnvio(i: { tipo: 'otp' | 'b2b'; clienteId: string; telefonoHmac: string | null; ipHmac: string | null; leadId: string | null; ahora: Date }): Promise<void>;
  publicarEvento(tipo: string, payload: Record<string, unknown>, clienteId: string, correlationId: string | null): Promise<void>;
  insertarContactoB2B(i: { nombre: string; empresa: string; email: string; servicio: string; mensaje: string | null; consentimientoVersion: string; ahora: Date }): Promise<string>;
}

export interface DepsCaptacion {
  sql: SqlClient;
  repo(conexion: SqlClient): CaptacionRepo;
  agenda: AgendaPort;
  mensajeria: MensajeriaPort;
  whatsapp: VerificadorWhatsAppPort;
  antiBot: AntiBotPort;
  formularios: FormulariosPort;
  /** = comunicacion.cifrarCodigoOtp(codigo, OTP_ENC_KEY): AES-GCM; el worker lo descifra al enviar. */
  cifrarCodigo(codigo: string): Promise<string>;
  hmacPepper: string;
  /** Canales de OTP habilitados (CANALES_OTP env). Por defecto todos: whatsapp, sms, email. */
  canalesOtp?: readonly CanalOtp[];
  clock: Clock;
  logger: Logger;
  random?: (n: number) => Uint8Array;
}

export interface Contexto {
  ip: string | null;
  correlationId: string | null;
}
