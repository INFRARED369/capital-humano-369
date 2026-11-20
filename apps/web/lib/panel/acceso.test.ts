import { describe, expect, it } from 'vitest';
import { leerEnlaceAuth, mensajeErrorContrasena, problemasContrasena } from './acceso';

describe('leerEnlaceAuth (enlace de invitación / recuperación de Supabase Auth)', () => {
  it('invitación con token', () => {
    expect(leerEnlaceAuth('#access_token=a.b.c&expires_in=3600&refresh_token=r&token_type=bearer&type=invite')).toEqual({ tipo: 'invite', tieneToken: true, error: null });
  });
  it('recuperación con token', () => {
    expect(leerEnlaceAuth('#access_token=x&type=recovery').tipo).toBe('recovery');
  });
  it('enlace vencido o ya usado', () => {
    expect(leerEnlaceAuth('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')).toEqual({ tipo: null, tieneToken: false, error: { codigo: 'otp_expired', vencido: true } });
    expect(leerEnlaceAuth('#error=server_error').error).toEqual({ codigo: 'server_error', vencido: false });
  });
  it('sin hash o con tipo desconocido', () => {
    expect(leerEnlaceAuth('')).toEqual({ tipo: null, tieneToken: false, error: null });
    expect(leerEnlaceAuth('#access_token=x&type=magiclink').tipo).toBe('otro');
  });
});

describe('problemasContrasena (config.toml: ≥ 12, minúsculas, mayúsculas y dígitos)', () => {
  it('válida', () => expect(problemasContrasena('Una-Clave-Segura-9', 'Una-Clave-Segura-9')).toEqual([]));
  it('marca cada requisito incumplido', () => {
    expect(problemasContrasena('corta', 'otra')).toEqual([
      'Usa al menos 12 caracteres.', 'Incluye al menos una letra mayúscula.', 'Incluye al menos un número.', 'Las contraseñas no coinciden.',
    ]);
    expect(problemasContrasena('SOLOMAYUSCULAS123', 'SOLOMAYUSCULAS123')).toEqual(['Incluye al menos una letra minúscula.']);
  });
  it('traduce errores de Auth', () => {
    expect(mensajeErrorContrasena('weak_password')).toMatch(/débil/);
    expect(mensajeErrorContrasena('same_password')).toMatch(/distinta/);
    expect(mensajeErrorContrasena('bad_jwt')).toMatch(/Pide uno nuevo/);
    expect(mensajeErrorContrasena(undefined)).toMatch(/Intenta de nuevo/);
  });
});
