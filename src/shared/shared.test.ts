import { describe, expect, it } from 'vitest';
import { crearLogger, redactar } from './logger.ts';
import { UUID_V7_RE, randomInt, uuidv7 } from './ids.ts';
import { hmacSha256Hex, normalizarTelefonoMx, sha256Hex, timingSafeEqual } from './crypto.ts';
import { FixedClock } from './clock.ts';
import { err, ok } from './result.ts';

describe('R8 · el logger redacta PII', () => {
  it('redacta teléfonos, correos, IPs y OTP en texto y por clave', () => {
    const lineas: string[] = [];
    const log = crearLogger({ fn: 'postular' }, (l) => lineas.push(l));
    log.info('lead 8112345678 de ana@x.com desde 189.203.1.2 con código 123456', { telefono: '8112345678', nombre: 'Ana', vacante_id: 'v1' });
    const out = lineas.join('\n');
    expect(out).not.toMatch(/8112345678|ana@x\.com|189\.203\.1\.2|123456|Ana/);
    expect(out).toContain('***');
    expect(out).toContain('v1');
  });
  it('redacta en objetos anidados y conserva nulos', () => {
    expect(redactar({ a: { email: 'x@y.z', ip: null }, b: ['5512345678'] })).toEqual({ a: { email: '***', ip: null }, b: ['***'] });
  });
  it('child hereda contexto', () => {
    const lineas: string[] = [];
    crearLogger({}, (l) => lineas.push(l)).child({ correlation_id: 'c1' }).warn('x');
    expect(JSON.parse(lineas[0]!)).toMatchObject({ nivel: 'warn', correlation_id: 'c1' });
  });
});

describe('ids', () => {
  it('uuidv7 válido y ordenable por tiempo', () => {
    const a = uuidv7(new Date('2026-01-01'));
    const b = uuidv7(new Date('2026-01-02'));
    expect(a).toMatch(UUID_V7_RE);
    expect(a < b).toBe(true);
  });
  it('randomInt sin sesgo dentro de rango y valida max', () => {
    for (let i = 0; i < 100; i++) expect(randomInt(10)).toBeLessThan(10);
    expect(() => randomInt(0)).toThrow();
  });
});

describe('crypto', () => {
  it('sha256 y hmac deterministas', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hmacSha256Hex('k', 'a')).toHaveLength(64);
    await expect(hmacSha256Hex('', 'a')).rejects.toThrow();
  });
  it('timingSafeEqual', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
  it('normaliza teléfonos MX', () => {
    expect(normalizarTelefonoMx('81 1234 5678')).toBe('528112345678');
    expect(normalizarTelefonoMx('+52 1 81 1234 5678')).toBe('528112345678');
    expect(normalizarTelefonoMx('811234567')).toBeNull();
  });
});

describe('clock y result', () => {
  it('FixedClock avanza', () => {
    const c = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    c.advanceMinutes(11);
    expect(c.now().toISOString()).toBe('2026-01-01T00:11:00.000Z');
    c.set('2026-02-01T00:00:00Z');
    expect(c.now().getUTCMonth()).toBe(1);
  });
  it('ok / err', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('x')).toEqual({ ok: false, error: 'x' });
  });
});
