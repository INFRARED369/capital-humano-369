import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { construirEventoMinimo } from '../domain/evento.ts';
import { crearZohoCalendarAdapter, dominiosZoho, type TokenCachePort, type ZohoConfig } from './zohoCalendarAdapter.ts';
import creado from './__fixtures__/evento-creado.json';
import actualizado from './__fixtures__/evento-actualizado.json';
import lista from './__fixtures__/eventos-lista.json';
import tokenOk from './__fixtures__/token-ok.json';
import tokenError from './__fixtures__/token-error.json';
import errTokenInvalido from './__fixtures__/error-token-invalido.json';
import errInterno from './__fixtures__/error-interno.json';
import errNoEncontrado from './__fixtures__/error-evento-no-encontrado.json';

const CAL = 'c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
const EV = '8b1c2f0e4a6d4e2b9a3c7d5e1f0a2b3c@zoho.com';
const cfg: ZohoConfig = { dc: 'com', clientId: 'cid-123', clientSecret: 'csecret-xyz', refreshToken: '1000.REFRESHSECRET.abc' };
const evento = (() => {
  const r = construirEventoMinimo(
    { citaId: '0192f5a0-0000-7000-8000-000000000001', folio: 'V-0042', nombrePila: 'María', inicio: '2026-11-16T16:00:00.000Z', fin: '2026-11-16T16:30:00.000Z' },
    { panelUrl: 'https://panel.369.mx', zonaHoraria: 'America/Mexico_City' },
  );
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();

type Respuesta = { status: number; body?: unknown } | Error;
interface Llamada { method: string; url: URL; headers: Headers; body: string | null }

/** fetch falso: responde al endpoint de token y a la API de calendario con colas de respuestas. */
function fetchFalso(api: Respuesta[], token: Respuesta[] = [{ status: 200, body: tokenOk }]) {
  const llamadas: Llamada[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const llamada = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body: (init?.body as string | undefined) ?? null };
    llamadas.push(llamada);
    const cola = url.pathname === '/oauth/v2/token' ? token : api;
    const r = cola.length > 1 ? cola.shift()! : cola[0];
    if (!r) throw new Error(`sin respuesta para ${url}`);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, llamadas, api: () => llamadas.filter((l) => l.url.pathname.startsWith('/api/')), tokens: () => llamadas.filter((l) => l.url.pathname === '/oauth/v2/token') };
}

function crear(f: ReturnType<typeof fetchFalso>, clock = new FixedClock(new Date('2026-11-13T18:00:00Z')), sink: string[] = []) {
  return crearZohoCalendarAdapter(cfg, { fetch: f.impl, clock, logger: crearLogger({}, (l) => sink.push(l)) });
}

describe('ZohoCalendarAdapter · endpoints y formato', () => {
  it('crear: refresca token (scope mínimo vía refresh_token) y hace POST con eventdata', async () => {
    const f = fetchFalso([{ status: 201, body: creado }]);
    const r = await crear(f).crear(CAL, evento);
    expect(r.ok && r.value.uid).toBe(EV);

    const [t] = f.tokens();
    expect(t!.method).toBe('POST');
    expect(t!.url.origin).toBe('https://accounts.zoho.com');
    const form = new URLSearchParams(t!.body ?? '');
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret });

    const [c] = f.api();
    expect(c!.method).toBe('POST');
    expect(c!.url.origin + c!.url.pathname).toBe(`https://calendar.zoho.com/api/v1/calendars/${CAL}/events`);
    expect(c!.headers.get('authorization')).toBe(`Zoho-oauthtoken ${tokenOk.access_token}`);
    const data = JSON.parse(c!.url.searchParams.get('eventdata')!);
    expect(data).toEqual({ title: evento.titulo, description: evento.descripcion, dateandtime: { timezone: 'America/Mexico_City', start: '20261116T160000Z', end: '20261116T163000Z' }, isallday: false });
    expect(data).not.toHaveProperty('reminders'); // Zoho rechaza [] (ARRAY_SIZE_OUT_OF_RANGE 1-4)
    expect(data).not.toHaveProperty('attendees');
  });

  it('data center configurable (Q-2): eu → *.zoho.eu; DC fuera de la lista se rechaza', async () => {
    expect(dominiosZoho('eu')).toEqual({ accounts: 'https://accounts.zoho.eu', calendar: 'https://calendar.zoho.eu' });
    expect(dominiosZoho('com.au').calendar).toBe('https://calendar.zoho.com.au');
    expect(() => dominiosZoho('evil.com/x')).toThrow(/ZOHO_DC/);
  });

  it('actualizar: PUT con etag numérico en eventdata', async () => {
    const f = fetchFalso([{ status: 200, body: actualizado }]);
    const r = await crear(f).actualizar(CAL, EV, '1763308800123', evento);
    expect(r.ok && r.value.inicio).toBe('2026-11-17T17:00:00.000Z');
    const [c] = f.api();
    expect(c!.method).toBe('PUT');
    expect(c!.url.pathname).toBe(`/api/v1/calendars/${CAL}/events/${encodeURIComponent(EV)}`);
    expect(JSON.parse(c!.url.searchParams.get('eventdata')!).etag).toBe(1763308800123);
  });

  it('borrar: DELETE con header etag; 404 se considera ya borrado (idempotente)', async () => {
    const f = fetchFalso([{ status: 200, body: { events: [{ uid: EV }] } }, { status: 404, body: errNoEncontrado }]);
    const a = crear(f);
    expect(await a.borrar(CAL, EV, '9')).toEqual({ ok: true, value: undefined });
    expect(f.api()[0]!.method).toBe('DELETE');
    expect(f.api()[0]!.headers.get('etag')).toBe('9');
    expect(await a.borrar(CAL, EV, '9')).toEqual({ ok: true, value: undefined });
  });

  it('obtener: evento o null si 404', async () => {
    const f = fetchFalso([{ status: 200, body: creado }, { status: 404, body: errNoEncontrado }]);
    const a = crear(f);
    const r1 = await a.obtener(CAL, EV);
    expect(r1.ok && r1.value?.uidPropio).toBe('cita-0192f5a0-0000-7000-8000-000000000001');
    expect(await a.obtener(CAL, 'otro')).toEqual({ ok: true, value: null });
  });

  it('listar: GET con range {start,end} por día', async () => {
    const f = fetchFalso([{ status: 200, body: lista }]);
    const r = await crear(f).listar(CAL, { desde: '2026-11-15T00:00:00Z', hasta: '2026-11-20T00:00:00Z' });
    expect(r.ok && r.value).toHaveLength(2);
    expect(JSON.parse(f.api()[0]!.url.searchParams.get('range')!)).toEqual({ start: '20261115', end: '20261120' });
  });

  it('listar: 204 sin cuerpo → lista vacía', async () => {
    const f = fetchFalso([{ status: 204 }]);
    expect(await crear(f).listar(CAL, { desde: '2026-11-15T00:00:00Z', hasta: '2026-11-16T00:00:00Z' })).toEqual({ ok: true, value: [] });
  });

  it('listar: eventos ajenos con forma rara (día completo, null, recurrentes) se omiten sin tumbar la sync', async () => {
    const raros = [
      { uid: 'allday@zoho.com', etag: 1, title: null, description: null, isallday: 'true', dateandtime: { start: '20261117', end: '20261118' }, attendees: ['x'] },
      { uid: 'sinfechas@zoho.com', etag: 2, title: 'Sin fechas' },
      { uid: 'fecharara@zoho.com', etag: 3, dateandtime: { start: '2026-11-17 10:00', end: '2026-11-17 11:00' } },
      'basura',
    ];
    const sink: string[] = [];
    const f = fetchFalso([{ status: 200, body: { events: [...lista.events, ...raros] } }]);
    const r = await crear(f, undefined, sink).listar(CAL, { desde: '2026-11-15T00:00:00Z', hasta: '2026-11-20T00:00:00Z' });
    expect(r.ok && r.value.map((e) => e.uid)).toEqual([...lista.events.map((e) => e.uid), 'allday@zoho.com']);
    const aviso = sink.map((l) => JSON.parse(l)).find((l) => /omitidos/.test(l.msg ?? l.mensaje ?? ''));
    expect(aviso).toMatchObject({ omitidos: 3, total: 6 });
    // El diagnóstico no lleva valores (títulos, fechas, correos), solo rutas y códigos.
    expect(sink.join('\n')).not.toMatch(/Sin fechas|2026-11-17 10:00|basura/);
  });

  it('listar: un evento PROPIO fuera de contrato sí es error (evita duplicarlo al recrear)', async () => {
    const propio = { ...lista.events[0], dateandtime: { start: 'mañana', end: 'luego' } };
    const f = fetchFalso([{ status: 200, body: { events: [propio] } }]);
    const r = await crear(f).listar(CAL, { desde: '2026-11-15T00:00:00Z', hasta: '2026-11-20T00:00:00Z' });
    expect(r).toEqual({ ok: false, error: { tipo: 'permanente', mensaje: 'respuesta de listar fuera de contrato' } });
  });

  it('listar: 200 sin events (Zoho no siempre manda la lista vacía) → lista vacía; con error → fuera de contrato', async () => {
    const rango = { desde: '2026-11-15T00:00:00Z', hasta: '2026-11-16T00:00:00Z' };
    expect(await crear(fetchFalso([{ status: 200, body: { message: 'No events found' } }])).listar(CAL, rango)).toEqual({ ok: true, value: [] });
    const r = await crear(fetchFalso([{ status: 200, body: { error: [{ code: 'X' }] } }])).listar(CAL, rango);
    expect(r.ok).toBe(false);
  });

  it('400: el motivo de Zoho queda en el error (código, mensaje, campo) sin datos personales', async () => {
    const cuerpo = { error: [{ code: 'PATTERN_NOT_MATCHED', message: 'Invalid value for maría@correo.mx 8112345678', field: 'dateandtime' }] };
    const r = await crear(fetchFalso([{ status: 400, body: cuerpo }])).crear(CAL, evento);
    expect(r).toEqual({ ok: false, error: { tipo: 'permanente', status: 400, mensaje: 'HTTP 400 PATTERN_NOT_MATCHED · Invalid value for # · dateandtime' } });
    const otro = await crear(fetchFalso([{ status: 400, body: { status: 'failure', reason: 'x' } }])).crear(CAL, evento);
    expect(!otro.ok && otro.error.mensaje).toBe('HTTP 400 llaves: status,reason');
  });

  it('el calendar_uid y el event_uid se codifican en la ruta (sin path traversal)', async () => {
    const f = fetchFalso([{ status: 200, body: creado }]);
    await crear(f).obtener('../../x', 'a/b');
    expect(f.api()[0]!.url.pathname).toBe('/api/v1/calendars/..%2F..%2Fx/events/a%2Fb');
  });
});

describe('ZohoCalendarAdapter · token (Z6)', () => {
  it('reutiliza el access token mientras no vence', async () => {
    const f = fetchFalso([{ status: 200, body: creado }]);
    const a = crear(f);
    await a.obtener(CAL, EV);
    await a.obtener(CAL, EV);
    expect(f.tokens()).toHaveLength(1);
  });

  it('renueva antes de vencer según el reloj', async () => {
    const f = fetchFalso([{ status: 200, body: creado }]);
    const clock = new FixedClock(new Date('2026-11-13T18:00:00Z'));
    const a = crear(f, clock);
    await a.obtener(CAL, EV);
    clock.advanceMinutes(58);
    await a.obtener(CAL, EV);
    expect(f.tokens()).toHaveLength(2);
  });

  it('Z6: access token vencido (401) → renueva y reintenta 1 vez', async () => {
    const f = fetchFalso([{ status: 401, body: errTokenInvalido }, { status: 201, body: creado }]);
    const r = await crear(f).crear(CAL, evento);
    expect(r.ok).toBe(true);
    expect(f.tokens()).toHaveLength(2);
    expect(f.api()).toHaveLength(2);
  });

  it('Z6: si tras renovar vuelve 401 → error auth, sin más reintentos', async () => {
    const f = fetchFalso([{ status: 401, body: errTokenInvalido }]);
    const r = await crear(f).crear(CAL, evento);
    expect(r).toEqual({ ok: false, error: { tipo: 'auth', status: 401, mensaje: expect.any(String) } });
    expect(f.api()).toHaveLength(2);
  });

  it('refresh token rechazado ({"error":"invalid_code"}) → error auth', async () => {
    const f = fetchFalso([{ status: 200, body: creado }], [{ status: 200, body: tokenError }]);
    const r = await crear(f).obtener(CAL, EV);
    expect(!r.ok && r.error.tipo).toBe('auth');
    expect(f.api()).toHaveLength(0);
  });

  it('endpoint de token caído → transitorio', async () => {
    const f = fetchFalso([{ status: 200, body: creado }], [{ status: 503 }]);
    const r = await crear(f).obtener(CAL, EV);
    expect(!r.ok && r.error.tipo).toBe('transitorio');
  });

  it('no escribe secretos ni tokens en los logs', async () => {
    const sink: string[] = [];
    const f = fetchFalso([{ status: 401, body: errTokenInvalido }, { status: 500, body: errInterno }]);
    await crear(f, undefined, sink).crear(CAL, evento);
    const todo = sink.join('\n');
    expect(sink.length).toBeGreaterThan(0);
    for (const s of [cfg.clientSecret, cfg.refreshToken, tokenOk.access_token, 'María']) expect(todo).not.toContain(s);
  });
});

describe('ZohoCalendarAdapter · clasificación de errores', () => {
  it.each([
    [500, 'transitorio'],
    [502, 'transitorio'],
    [429, 'transitorio'],
    [408, 'transitorio'],
    [412, 'conflicto'],
    [422, 'permanente'],
    [400, 'permanente'],
    [403, 'permanente'],
  ] as const)('HTTP %i → %s', async (status, tipo) => {
    const f = fetchFalso([{ status, body: errInterno }]);
    const r = await crear(f).crear(CAL, evento);
    expect(!r.ok && r.error).toMatchObject({ tipo, status });
  });

  it('crear con 404 (calendario inexistente) → no_encontrado', async () => {
    const f = fetchFalso([{ status: 404, body: errNoEncontrado }]);
    const r = await crear(f).crear(CAL, evento);
    expect(!r.ok && r.error.tipo).toBe('no_encontrado');
  });

  it('error de red → transitorio', async () => {
    const f = fetchFalso([new TypeError('fetch failed')]);
    const r = await crear(f).crear(CAL, evento);
    expect(!r.ok && r.error.tipo).toBe('transitorio');
  });

  it('respuesta 200 que no cumple el contrato → permanente', async () => {
    const f = fetchFalso([{ status: 200, body: { events: [{ nada: 1 }] } }]);
    const r = await crear(f).crear(CAL, evento);
    expect(!r.ok && r.error.tipo).toBe('permanente');
  });

  it('respuesta 200 de crear sin eventos → permanente', async () => {
    const f = fetchFalso([{ status: 200, body: { events: [] } }]);
    const r = await crear(f).crear(CAL, evento);
    expect(!r.ok && r.error.tipo).toBe('permanente');
  });
});

describe('ZohoCalendarAdapter · caché del access token compartida entre isolates (límite de Zoho)', () => {
  function cacheFalsa() {
    let guardado: { token: string; venceEn: number } | null = null;
    const escrituras: string[] = [];
    const port: TokenCachePort = {
      leer: async () => guardado,
      guardar: async (token, venceEn) => { guardado = { token, venceEn }; escrituras.push(token); },
    };
    return { port, escrituras, fijar: (g: typeof guardado) => { guardado = g; } };
  }
  const clock = () => new FixedClock(new Date('2026-11-13T18:00:00Z'));

  it('un isolate nuevo reutiliza el token guardado en BD sin pedir otro a Zoho', async () => {
    const cache = cacheFalsa();
    const c = clock();
    const f1 = fetchFalso([{ status: 201, body: creado }]);
    await crearZohoCalendarAdapter(cfg, { fetch: f1.impl, clock: c, logger: crearLogger({}, () => {}), tokenCache: cache.port }).crear(CAL, evento);
    expect(f1.tokens()).toHaveLength(1);
    expect(cache.escrituras).toEqual([tokenOk.access_token]);
    const f2 = fetchFalso([{ status: 201, body: creado }]);
    await crearZohoCalendarAdapter(cfg, { fetch: f2.impl, clock: c, logger: crearLogger({}, () => {}), tokenCache: cache.port }).crear(CAL, evento);
    expect(f2.tokens()).toHaveLength(0);
    expect(f2.api()[0]!.headers.get('authorization')).toBe(`Zoho-oauthtoken ${tokenOk.access_token}`);
  });

  it('token guardado por vencer (margen de 5 min) o 401 → se renueva y se guarda el nuevo; caché caída → sigue funcionando', async () => {
    const c = clock();
    const cache = cacheFalsa();
    cache.fijar({ token: 'viejo', venceEn: c.now().getTime() + 60_000 });
    const f = fetchFalso([{ status: 201, body: creado }]);
    await crearZohoCalendarAdapter(cfg, { fetch: f.impl, clock: c, logger: crearLogger({}, () => {}), tokenCache: cache.port }).crear(CAL, evento);
    expect(f.tokens()).toHaveLength(1);

    cache.fijar({ token: 'revocado', venceEn: c.now().getTime() + 3_600_000 });
    const f401 = fetchFalso([{ status: 401, body: errTokenInvalido }, { status: 201, body: creado }]);
    const r = await crearZohoCalendarAdapter(cfg, { fetch: f401.impl, clock: c, logger: crearLogger({}, () => {}), tokenCache: cache.port }).crear(CAL, evento);
    expect(r.ok).toBe(true);
    expect(f401.tokens()).toHaveLength(1);
    expect(cache.escrituras.at(-1)).toBe(tokenOk.access_token);

    const rota: TokenCachePort = { leer: async () => { throw new Error('db'); }, guardar: async () => { throw new Error('db'); } };
    const f3 = fetchFalso([{ status: 201, body: creado }]);
    expect((await crearZohoCalendarAdapter(cfg, { fetch: f3.impl, clock: c, logger: crearLogger({}, () => {}), tokenCache: rota }).crear(CAL, evento)).ok).toBe(true);
  });
});
