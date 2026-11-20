import { describe, expect, it } from 'vitest';
import { esIpValida, truncarIp } from './ip.ts';

describe('R5 · truncado de IP', () => {
  it('IPv4 a /24', () => {
    expect(truncarIp('189.203.17.45')).toBe('189.203.17.0');
  });
  it('IPv6 a /48 (incluye forma comprimida)', () => {
    expect(truncarIp('2806:2f0:9020:abcd:1:2:3:4')).toBe('2806:2f0:9020::');
    expect(truncarIp('2001:db8::1')).toBe('2001:db8::');
    expect(truncarIp('::1')).toBe('::');
  });
  it('IPv4 mapeada en IPv6 se trata como IPv4', () => {
    expect(truncarIp('::ffff:10.1.2.3')).toBe('10.1.2.0');
  });
  it('valores inválidos → null', () => {
    expect(truncarIp('hola')).toBeNull();
    expect(truncarIp('300.1.1.1')).toBeNull();
    expect(esIpValida('1.2.3.4')).toBe(true);
    expect(esIpValida('2001:db8::1')).toBe(true);
    expect(esIpValida('1.2.3')).toBe(false);
    expect(esIpValida('2001:db8:::1')).toBe(false);
    expect(esIpValida('')).toBe(false);
  });
});
