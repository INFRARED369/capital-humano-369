import { z } from 'zod';

export const TIPOS_MENSAJE = ['otp', 'confirmacion', 'recordatorio_24h', 'recordatorio_2h', 'cancelacion', 'reprogramacion', 'agradecimiento'] as const;
export type TipoMensaje = (typeof TIPOS_MENSAJE)[number];

export const CANALES = ['whatsapp', 'email', 'sms'] as const;
export type Canal = (typeof CANALES)[number];

/**
 * Variables que el llamador puede guardar en la cola. Nombre, folio y código NO
 * viajan aquí: se resuelven al enviar (ContactosPort / OTP cifrado) para que la
 * cola y la bitácora no guarden PII en claro.
 */
export const VARIABLES_SOLICITUD = ['fecha', 'hora', 'link_cancelar', 'link_reprogramar'] as const;

/** M9: menor = más prioridad (shared.cola admite 0..9). */
const PRIORIDADES: Record<TipoMensaje, number> = {
  otp: 0,
  confirmacion: 2,
  cancelacion: 2,
  reprogramacion: 2,
  recordatorio_2h: 3,
  recordatorio_24h: 4,
  agradecimiento: 6,
};
export const prioridadDe = (tipo: TipoMensaje): number => PRIORIDADES[tipo];

const uuid = z.uuid();

export const SolicitudMensajeSchema = z
  .object({
    tipo: z.enum(TIPOS_MENSAJE),
    canal: z.enum(CANALES),
    leadId: uuid,
    vacanteId: uuid,
    clienteId: uuid,
    llave: z.string().min(1).max(200),
    variables: z
      .record(z.string(), z.string().max(500))
      .refine((v) => Object.keys(v).every((k) => (VARIABLES_SOLICITUD as readonly string[]).includes(k)), {
        message: `solo se admiten variables ${VARIABLES_SOLICITUD.join(', ')}`,
      })
      .optional(),
    programadoPara: z.iso.datetime({ offset: true }).optional(),
    codigoCifrado: z.string().min(1).max(500).optional(),
    /** Extensión compatible: id de la cita para cancelar recordatorios (M7). */
    citaId: uuid.optional(),
    /** Extensión compatible: correlation_id para trazabilidad (NFR-OBS-01). */
    correlationId: z.string().max(64).optional(),
  })
  .refine((s) => (s.tipo === 'otp') === (s.codigoCifrado !== undefined), {
    message: 'el OTP requiere codigoCifrado y solo el OTP lo admite',
    path: ['codigoCifrado'],
  });

export type SolicitudMensaje = z.input<typeof SolicitudMensajeSchema>;

export type EstadoMensaje = 'pendiente' | 'enviando' | 'reintento' | 'enviado' | 'fallido' | 'cancelado' | 'omitido';
export const ESTADOS_ACTIVOS: readonly EstadoMensaje[] = ['pendiente', 'enviando', 'reintento'];
