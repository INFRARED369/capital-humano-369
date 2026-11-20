/** Solicitudes ARCO y revocación del consentimiento (PRV-02, Política §3). Puro. */
import { err, ok, type Result } from '@shared/result.ts';
import { diasHabilesHasta, fechaLocal } from './plazos.ts';

export const TIPOS_ARCO = ['acceso', 'rectificacion', 'cancelacion', 'oposicion', 'revocacion'] as const;
export type TipoArco = (typeof TIPOS_ARCO)[number];

export const ESTADOS_ARCO = ['recibida', 'ejecutada', 'respondida', 'rechazada'] as const;
export type EstadoArco = (typeof ESTADOS_ARCO)[number];

export const CANALES_ARCO = ['correo', 'formulario', 'whatsapp', 'otro'] as const;
export type CanalArco = (typeof CANALES_ARCO)[number];

export type AccionArco = 'ejecutar' | 'responder' | 'rechazar';

/** Cancelar, oponerse o revocar: supresión inmediata del lead, Zoho, cola y opt-out permanente (§3). */
export const requiereSupresion = (t: TipoArco): boolean => t === 'cancelacion' || t === 'oposicion' || t === 'revocacion';

export function transicionArco(estado: EstadoArco, accion: AccionArco, tipo: TipoArco): Result<EstadoArco, 'TRANSICION_INVALIDA' | 'TIPO_NO_EJECUTABLE'> {
  if (estado !== 'recibida') return err('TRANSICION_INVALIDA');
  if (accion === 'ejecutar') return requiereSupresion(tipo) ? ok('ejecutada') : err('TIPO_NO_EJECUTABLE');
  return ok(accion === 'responder' ? 'respondida' : 'rechazada');
}

export type Vencimiento = 'cerrada' | 'en_plazo' | 'por_vencer' | 'respuesta_vencida';
export const AVISO_DIAS_HABILES = 3;

export function vencimiento(s: { estado: EstadoArco; limiteRespuesta: string; limiteEjecucion: string }, ahora: Date): Vencimiento {
  if (s.estado !== 'recibida') return 'cerrada';
  if (fechaLocal(ahora) > s.limiteRespuesta) return 'respuesta_vencida';
  return diasHabilesHasta(ahora, s.limiteRespuesta) <= AVISO_DIAS_HABILES ? 'por_vencer' : 'en_plazo';
}
