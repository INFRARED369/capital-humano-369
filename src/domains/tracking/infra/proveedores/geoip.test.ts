import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearGeoIpDesdeEntorno, crearGeoIpHttp, geoIpNulo, normalizarRespuestaGeo } from './geoip.ts';

function fetchFalso(respuestas: (Record<string, unknown> | number | 'red' | 'lento')[]) {
  const urls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const r = respuestas.shift() ?? 500;
    if (r === 'red') throw new TypeError('fetch failed');
    if (r === 'lento') {
      return await new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))));
    }
    if (typeof r === 'number') return new Response('{}', { status: r });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, urls };
}

describe('normalizarRespuestaGeo (ipapi.co, ipinfo.io, ip-api.com)', () => {
  it('mapea los formatos más comunes y solo conserva ciudad/región/país', () => {
    expect(normalizarRespuestaGeo({ ip: '189.203.1.0', city: 'Monterrey', region: 'Nuevo León', region_code: 'NLE', country_code: 'MX', latitude: 25.6, org: 'Telmex' }))
      .toEqual({ ciudad: 'Monterrey', region: 'Nuevo León', pais: 'MX' });
    expect(normalizarRespuestaGeo({ ip: 'x', city: 'Guadalajara', region: 'Jalisco', country: 'MX', loc: '20.6,-103.3' })).toEqual({ ciudad: 'Guadalajara', region: 'Jalisco', pais: 'MX' });
    expect(normalizarRespuestaGeo({ status: 'success', city: 'Puebla', regionName: 'Puebla', countryCode: 'mx' })).toEqual({ ciudad: 'Puebla', region: 'Puebla', pais: 'MX' });
  });
  it('error del proveedor, IP reservada o sin datos útiles → null; país que no es ISO-2 se descarta', () => {
    expect(normalizarRespuestaGeo({ error: true, reason: 'Reserved IP Address' })).toBeNull();
    expect(normalizarRespuestaGeo({ status: 'fail', message: 'private range' })).toBeNull();
    expect(normalizarRespuestaGeo({ bogon: true })).toBeNull();
    expect(normalizarRespuestaGeo('basura')).toBeNull();
    expect(normalizarRespuestaGeo({ city: 'X'.repeat(300), country: 'Mexico' })).toEqual({ ciudad: 'X'.repeat(100), region: null, pais: null });
  });
});

describe('crearGeoIpHttp', () => {
  const clock = new FixedClock(new Date('2026-11-17T18:00:00Z'));
  it('sustituye {ip} (codificada), usa timeout y cachea por IP consultada', async () => {
    const { f, urls } = fetchFalso([{ city: 'Monterrey', region: 'Nuevo León', country_code: 'MX' }]);
    const g = crearGeoIpHttp({ urlPlantilla: 'https://ipapi.co/{ip}/json/', fetch: f, clock });
    expect(await g.resolver('189.203.1.0')).toEqual({ ciudad: 'Monterrey', region: 'Nuevo León', pais: 'MX' });
    expect(await g.resolver('189.203.1.0')).toEqual({ ciudad: 'Monterrey', region: 'Nuevo León', pais: 'MX' });
    expect(urls).toEqual(['https://ipapi.co/189.203.1.0/json/']);
    clock.advance(25 * 3_600_000); // TTL 24 h vencido
    await g.resolver('189.203.1.0');
    expect(urls).toHaveLength(2);
  });
  it('HTTP no 2xx, error de red o timeout → null (no rompe el worker)', async () => {
    const { f } = fetchFalso([429, 'red', 'lento']);
    const g = crearGeoIpHttp({ urlPlantilla: 'https://ipinfo.io/{ip}/json?token=t', fetch: f, clock, timeoutMs: 20 });
    expect(await g.resolver('1.1.1.0')).toBeNull();
    expect(await g.resolver('1.1.2.0')).toBeNull();
    expect(await g.resolver('1.1.3.0')).toBeNull();
  });
  it('plantilla sin {ip} o no https → error al crear; la caché tiene tope de tamaño', async () => {
    const { f, urls } = fetchFalso(Array.from({ length: 5 }, () => ({ city: 'A', country: 'MX' })));
    expect(() => crearGeoIpHttp({ urlPlantilla: 'https://ipapi.co/json', fetch: f, clock })).toThrow(/\{ip\}/);
    expect(() => crearGeoIpHttp({ urlPlantilla: 'http://ip-api.com/json/{ip}', fetch: f, clock })).toThrow(/https/);
    const g = crearGeoIpHttp({ urlPlantilla: 'https://x.test/{ip}', fetch: f, clock, maxCache: 2 });
    for (const ip of ['1.0.0.0', '2.0.0.0', '3.0.0.0', '1.0.0.0']) await g.resolver(ip);
    expect(urls).toHaveLength(4); // 1.0.0.0 salió de la caché al entrar 3.0.0.0
  });
});

describe('selección por entorno', () => {
  it('GEOIP_URL vacía → proveedor nulo (TRK-07 c); con URL → HTTP', async () => {
    expect(crearGeoIpDesdeEntorno({}, fetchFalso([]).f)).toBe(geoIpNulo);
    expect(await geoIpNulo.resolver('1.2.3.0')).toBeNull();
    const g = crearGeoIpDesdeEntorno({ GEOIP_URL: 'https://ipapi.co/{ip}/json/', GEOIP_TIMEOUT_MS: '800' }, fetchFalso([{ city: 'León', country_code: 'MX' }]).f);
    expect(await g.resolver('8.8.8.0')).toEqual({ ciudad: 'León', region: null, pais: 'MX' });
  });
});
