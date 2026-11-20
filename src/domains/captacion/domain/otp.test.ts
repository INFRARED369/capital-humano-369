import { describe, expect, it } from 'vitest';
import { OTP, evaluarIntento, evaluarLimiteEnvio, expiracionOtp, generarCodigoOtp, hashCodigoOtp, type EstadoOtp } from './otp.ts';

const ahora = new Date('2026-11-16T15:00:00Z');

describe('generación y hash del OTP', () => {
  it('genera 6 dígitos (con ceros a la izquierda)', () => {
    for (let i = 0; i < 50; i++) expect(generarCodigoOtp()).toMatch(/^\d{6}$/);
    const ceros = generarCodigoOtp(() => new Uint8Array([0, 0, 0, 7]));
    expect(ceros).toBe('000007');
  });
  it('hash HMAC con pepper ligado al id del OTP; nunca contiene el código', async () => {
    const h1 = await hashCodigoOtp('pepper', 'otp-1', '123456');
    const h2 = await hashCodigoOtp('pepper', 'otp-2', '123456');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain('123456');
    expect(await hashCodigoOtp('pepper', 'otp-1', '123456')).toBe(h1);
  });
  it('expira en 10 minutos', () => {
    expect(expiracionOtp(ahora).toISOString()).toBe('2026-11-16T15:10:00.000Z');
    expect(OTP.TTL_MIN).toBe(10);
  });
});

describe('evaluarIntento (O1–O3)', () => {
  const base: EstadoOtp = { codigoHash: 'a'.repeat(64), expiraEn: expiracionOtp(ahora), intentos: 0, estado: 'vigente' };

  it('O1 · correcto dentro del TTL', () => {
    expect(evaluarIntento(base, 'a'.repeat(64), ahora)).toEqual({ resultado: 'CORRECTO' });
  });
  it('incorrecto descuenta intentos', () => {
    expect(evaluarIntento(base, 'b'.repeat(64), ahora)).toEqual({ resultado: 'INCORRECTO', intentos: 1, restantes: 4 });
  });
  it('O2 · el 5.º error bloquea', () => {
    expect(evaluarIntento({ ...base, intentos: 4 }, 'b'.repeat(64), ahora)).toEqual({ resultado: 'BLOQUEADO', intentos: 5 });
  });
  it('un OTP bloqueado no acepta ni el código correcto', () => {
    expect(evaluarIntento({ ...base, estado: 'bloqueado', intentos: 5 }, 'a'.repeat(64), ahora)).toEqual({ resultado: 'BLOQUEADO', intentos: 5 });
    expect(evaluarIntento({ ...base, intentos: 5 }, 'a'.repeat(64), ahora)).toEqual({ resultado: 'BLOQUEADO', intentos: 5 });
  });
  it('O3 · vencido (justo en el límite también)', () => {
    expect(evaluarIntento(base, 'a'.repeat(64), new Date(base.expiraEn.getTime()))).toEqual({ resultado: 'VENCIDO' });
    expect(evaluarIntento({ ...base, estado: 'vencido' }, 'a'.repeat(64), ahora)).toEqual({ resultado: 'VENCIDO' });
  });
  it('reemplazado o ya verificado no se puede usar', () => {
    expect(evaluarIntento({ ...base, estado: 'reemplazado' }, 'a'.repeat(64), ahora)).toEqual({ resultado: 'NO_VIGENTE' });
    expect(evaluarIntento({ ...base, estado: 'verificado' }, 'a'.repeat(64), ahora)).toEqual({ resultado: 'YA_VERIFICADO' });
  });
});

describe('límites de envío (O4, NFR-SEG-03)', () => {
  it('3 códigos por teléfono por hora', () => {
    expect(evaluarLimiteEnvio({ porTelefono: 0, porIp: 0 })).toEqual({ ok: true, value: { restantesTelefono: 2 } });
    expect(evaluarLimiteEnvio({ porTelefono: 2, porIp: 2 })).toEqual({ ok: true, value: { restantesTelefono: 0 } });
    expect(evaluarLimiteEnvio({ porTelefono: 3, porIp: 3 })).toEqual({ ok: false, error: 'LIMITE_TELEFONO' });
  });
  it('10 por IP por hora', () => {
    expect(evaluarLimiteEnvio({ porTelefono: 0, porIp: 10 })).toEqual({ ok: false, error: 'LIMITE_IP' });
    expect(evaluarLimiteEnvio({ porTelefono: 0, porIp: 9 }).ok).toBe(true);
  });
  it('constantes del plan', () => {
    expect(OTP).toMatchObject({ DIGITOS: 6, MAX_INTENTOS: 5, MAX_ENVIOS_TELEFONO_HORA: 3, MAX_ENVIOS_IP_HORA: 10 });
  });
});
