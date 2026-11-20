/**
 * Verificación de WhatsApp por OTP (D11, §1.1, O1–O5, NFR-SEG-03).
 * El código vive en claro solo en memoria del proceso que lo genera; en la BD solo su HMAC.
 */
import { hmacSha256Hex, timingSafeEqual } from '../../../shared/crypto.ts';
import { randomBytes, randomInt } from '../../../shared/ids.ts';
import { err, ok, type Result } from '../../../shared/result.ts';

export const OTP = {
  DIGITOS: 6,
  TTL_MIN: 10,
  MAX_INTENTOS: 5,
  MAX_ENVIOS_TELEFONO_HORA: 3,
  MAX_ENVIOS_IP_HORA: 10,
} as const;

/** Canales por los que el candidato puede recibir el código (elegible y cambiable en cada reenvío). */
export const CANALES_OTP = ['whatsapp', 'sms', 'email'] as const;
export type CanalOtp = (typeof CANALES_OTP)[number];

export function generarCodigoOtp(random: (n: number) => Uint8Array = randomBytes): string {
  return String(randomInt(10 ** OTP.DIGITOS, random)).padStart(OTP.DIGITOS, '0');
}

/** HMAC(pepper, "otp:{otpId}:{codigo}"): ligado al id para que dos OTP iguales no compartan hash. */
export function hashCodigoOtp(pepper: string, otpId: string, codigo: string): Promise<string> {
  return hmacSha256Hex(pepper, `otp:${otpId}:${codigo}`);
}

export function expiracionOtp(ahora: Date): Date {
  return new Date(ahora.getTime() + OTP.TTL_MIN * 60_000);
}

export type EstadoOtpNombre = 'vigente' | 'verificado' | 'bloqueado' | 'reemplazado' | 'vencido';
export interface EstadoOtp {
  codigoHash: string;
  expiraEn: Date;
  intentos: number;
  estado: EstadoOtpNombre;
}

export type ResultadoIntento =
  | { resultado: 'CORRECTO' }
  | { resultado: 'INCORRECTO'; intentos: number; restantes: number }
  | { resultado: 'BLOQUEADO'; intentos: number }
  | { resultado: 'VENCIDO' }
  | { resultado: 'NO_VIGENTE' }
  | { resultado: 'YA_VERIFICADO' };

/** Decide el resultado de un intento. La comparación del hash es en tiempo constante. */
export function evaluarIntento(otp: EstadoOtp, hashIngresado: string, ahora: Date): ResultadoIntento {
  const coincide = timingSafeEqual(otp.codigoHash, hashIngresado);
  if (otp.estado === 'verificado') return { resultado: 'YA_VERIFICADO' };
  if (otp.estado === 'reemplazado') return { resultado: 'NO_VIGENTE' };
  if (otp.estado === 'bloqueado' || otp.intentos >= OTP.MAX_INTENTOS) return { resultado: 'BLOQUEADO', intentos: otp.intentos };
  if (otp.estado === 'vencido' || ahora.getTime() >= otp.expiraEn.getTime()) return { resultado: 'VENCIDO' };
  if (coincide) return { resultado: 'CORRECTO' };
  const intentos = otp.intentos + 1;
  if (intentos >= OTP.MAX_INTENTOS) return { resultado: 'BLOQUEADO', intentos };
  return { resultado: 'INCORRECTO', intentos, restantes: OTP.MAX_INTENTOS - intentos };
}

/** Envíos de código en la última hora → ¿se permite uno más? (O4: el 4.º código por teléfono en una hora → 429). */
export function evaluarLimiteEnvio(conteos: { porTelefono: number; porIp: number }): Result<{ restantesTelefono: number }, 'LIMITE_TELEFONO' | 'LIMITE_IP'> {
  if (conteos.porTelefono >= OTP.MAX_ENVIOS_TELEFONO_HORA) return err('LIMITE_TELEFONO');
  if (conteos.porIp >= OTP.MAX_ENVIOS_IP_HORA) return err('LIMITE_IP');
  return ok({ restantesTelefono: OTP.MAX_ENVIOS_TELEFONO_HORA - conteos.porTelefono - 1 });
}
