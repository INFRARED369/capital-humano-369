/** Handlers puros `retencion-diaria` y `arco` + autenticación (sin BD). */
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { err, ok } from '@shared/result.ts';
import type { SqlClient } from '@shared/sql.ts';
import type { DepsPrivacidad, PrivacidadRepo, ResumenRetencion, SolicitudArco } from '../../application/puertos.ts';
import { crearHandlerRetencion } from './retencion.ts';
import { crearHandlerArco } from './arco.ts';
import { claimDe, crearAutenticadorArco, crearEsAdminSql, crearVerificadorSupabase, type Autenticado, type FallaAuth } from './autenticacion.ts';
import { crearContactosDesdeCaptacion } from '../contactos.ts';

const SECRETO = 's'.repeat(40);
const RESUMEN: ResumenRetencion = { registroId: 7, omitida: false, dominios: ['captacion'], faltantes: [], errores: {}, lotes: { captacion: 1 }, conteos: { captacion: { leads: 1 } }, total: 1 };
const ID = '00000000-0000-4000-8000-000000000001';

function logs() {
  const l: string[] = [];
  return { l, log: crearLogger({ funcion: 'prueba' }, (x) => l.push(x)) };
}

describe('crearHandlerRetencion', () => {
  const req = (o: RequestInit = {}) => new Request('https://x/retencion-diaria', { method: 'POST', ...o });
  it('405 si no es POST, 401 sin Bearer o con Bearer distinto', async () => {
    const { log } = logs();
    const h = crearHandlerRetencion({ secreto: SECRETO, log, ejecutar: async () => RESUMEN });
    expect((await h(new Request('https://x', { method: 'GET' }))).status).toBe(405);
    expect((await h(req())).status).toBe(401);
    expect((await h(req({ headers: { authorization: 'Bearer otro' } }))).status).toBe(401);
    const vacio = crearHandlerRetencion({ secreto: '', log, ejecutar: async () => RESUMEN });
    expect((await vacio(req({ headers: { authorization: 'Bearer ' } }))).status).toBe(401);
  });
  it('200 con el resumen de conteos', async () => {
    const { log } = logs();
    const h = crearHandlerRetencion({ secreto: SECRETO, log, ejecutar: async () => RESUMEN });
    const res = await h(req({ headers: { authorization: `Bearer ${SECRETO}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, registro_id: 7, total: 1, conteos: { captacion: { leads: 1 } } });
  });
  it('500 genérico si falla (sin el mensaje)', async () => {
    const { log, l } = logs();
    const h = crearHandlerRetencion({ secreto: SECRETO, log, ejecutar: async () => { throw new Error('falló con 528112345678'); } });
    const res = await h(req({ headers: { authorization: `Bearer ${SECRETO}` } }));
    expect(res.status).toBe(500);
    expect(l.join() + (await res.text())).not.toContain('528112345678');
  });
});

class Repo implements PrivacidadRepo {
  s: SolicitudArco = { id: ID, tipo: 'cancelacion', canal: 'correo', estado: 'recibida', recibidaEn: '2026-11-17T18:00:00.000Z', limiteRespuesta: '2026-12-15', limiteEjecucion: '2027-01-07', cerradaEn: null, leads: 1, resultado: null };
  async retencionDiaria() { return RESUMEN; }
  async registrarSolicitud() { return ID; }
  async obtenerSolicitud(id: string) { return id === ID ? this.s : null; }
  async listarSolicitudes() { return [this.s]; }
  async ejecutarSolicitud() { return this.s.estado === 'recibida' ? ok({ conteos: { leads: 1 }, faltantes: ['x.y'] }) : err('TRANSICION_INVALIDA' as const); }
  async responderSolicitud() { return ok(undefined); }
}

function handler(autenticado: Autenticado | FallaAuth = { tipo: 'admin', userId: ID }) {
  const { log, l } = logs();
  const privacidad: DepsPrivacidad = { repo: new Repo(), contactos: { telefonoDeLead: async () => null }, clock: new FixedClock(new Date('2026-11-17T18:00:00Z')), logger: log, pepper: 'p'.repeat(32) };
  const h = crearHandlerArco({ autenticar: async () => autenticado, privacidad, log });
  const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    h(new Request('https://x/arco', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { h, post, l };
}

describe('crearHandlerArco', () => {
  it('método, autenticación y formato', async () => {
    expect((await handler().h(new Request('https://x', { method: 'GET' }))).status).toBe(405);
    expect((await handler('NO_AUTENTICADO').post({})).status).toBe(401);
    expect((await handler('PROHIBIDO').post({})).status).toBe(403);
    expect((await handler('MFA_REQUERIDA').post({})).status).toBe(403);
    expect((await handler().post({}, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await handler().post('x'.repeat(5000))).status).toBe(413);
    expect((await handler().post('{}', { 'content-type': 'application/json', 'content-length': '999999' })).status).toBe(413);
    expect((await handler().post('{no')).status).toBe(400);
    const inval = await handler().post({ accion: 'registrar', tipo: 'borrar_todo', canal: 'correo' });
    expect(inval.status).toBe(400);
    expect(await inval.json()).toEqual({ error: 'ENTRADA_INVALIDA', campos: ['tipo'] });
  });
  it('registrar (servicio) → 201; sin identificador → 400', async () => {
    const { post } = handler({ tipo: 'servicio' });
    const r = await post({ accion: 'registrar', tipo: 'acceso', canal: 'correo', telefono: '8112345678' });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ solicitud_id: ID, limite_respuesta: '2026-12-15', ejecucion: null });
    expect((await post({ accion: 'registrar', tipo: 'acceso', canal: 'correo' })).status).toBe(400);
  });
  it('ejecutar, responder, consultar y listar', async () => {
    const { post } = handler();
    expect(await (await post({ accion: 'ejecutar', solicitud_id: ID })).json()).toEqual({ ok: true, conteos: { leads: 1 }, faltantes: ['x.y'] });
    expect((await post({ accion: 'ejecutar', solicitud_id: '00000000-0000-4000-8000-000000000009' })).status).toBe(404);
    expect((await post({ accion: 'responder', solicitud_id: ID, resultado: 'respondida', motivo: 'datos_entregados' })).status).toBe(200);
    expect((await post({ accion: 'responder', solicitud_id: ID, resultado: 'respondida', motivo: 'texto libre' })).status).toBe(400);
    expect(await (await post({ accion: 'consultar', solicitud_id: ID })).json()).toMatchObject({ id: ID, vencimiento: 'en_plazo' });
    expect((await post({ accion: 'consultar', solicitud_id: '00000000-0000-4000-8000-000000000009' })).status).toBe(404);
    expect(await (await post({ accion: 'listar', estado: 'recibida' })).json()).toMatchObject({ solicitudes: [{ id: ID }] });
  });
  it('acceso denegado se registra sin el token', async () => {
    const { post, l } = handler('PROHIBIDO');
    await post({});
    expect(l.join()).toContain('arco_acceso_denegado');
  });
});

describe('autenticación', () => {
  const jwt = (claims: Record<string, unknown>) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.firma`;
  const auth = (o: { usuario?: { userId: string; aal: string | null } | null; admin?: boolean; mfa?: boolean } = {}) => crearAutenticadorArco({
    serviceKey: SECRETO, verificarToken: async () => (o.usuario === undefined ? { userId: ID, aal: 'aal2' } : o.usuario), esAdmin: async () => o.admin ?? true, requiereMfa: o.mfa,
  });
  const req = (token?: string) => new Request('https://x', { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

  it('service key → servicio; sin token → NO_AUTENTICADO', async () => {
    expect(await auth()(req(SECRETO))).toEqual({ tipo: 'servicio' });
    expect(await auth()(req())).toBe('NO_AUTENTICADO');
    expect(await auth()(req('x'.repeat(5000)))).toBe('NO_AUTENTICADO');
  });
  it('token inválido, no admin, sin MFA', async () => {
    expect(await auth({ usuario: null })(req('t'))).toBe('NO_AUTENTICADO');
    expect(await auth({ admin: false })(req('t'))).toBe('PROHIBIDO');
    expect(await auth({ usuario: { userId: ID, aal: 'aal1' } })(req('t'))).toBe('MFA_REQUERIDA');
    expect(await auth({ usuario: { userId: ID, aal: 'aal1' }, mfa: false })(req('t'))).toEqual({ tipo: 'admin', userId: ID });
    expect(await auth()(req('t'))).toEqual({ tipo: 'admin', userId: ID });
  });
  it('claimDe lee el payload (base64url) y tolera basura', () => {
    expect(claimDe(jwt({ aal: 'aal2', sub: ID }), 'aal')).toBe('aal2');
    expect(claimDe(jwt({ aal: 2 }), 'aal')).toBeNull();
    expect(claimDe('sin-puntos', 'aal')).toBeNull();
    expect(claimDe('a.%%%.c', 'aal')).toBeNull();
  });
  it('crearVerificadorSupabase consulta /auth/v1/user con el token y la apikey', async () => {
    const llamadas: Array<{ url: string; headers: Headers }> = [];
    const f = (status: number, body: unknown) => (async (url: string, init?: RequestInit) => {
      llamadas.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const token = jwt({ aal: 'aal2' });
    expect(await crearVerificadorSupabase({ url: 'https://p.supabase.co/', apiKey: 'anon', fetch: f(200, { id: ID }) })(token)).toEqual({ userId: ID, aal: 'aal2' });
    expect(llamadas[0]!.url).toBe('https://p.supabase.co/auth/v1/user');
    expect(llamadas[0]!.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(llamadas[0]!.headers.get('apikey')).toBe('anon');
    expect(await crearVerificadorSupabase({ url: 'https://p', apiKey: 'a', fetch: f(401, {}) })(token)).toBeNull();
    expect(await crearVerificadorSupabase({ url: 'https://p', apiKey: 'a', fetch: f(200, { id: 3 }) })(token)).toBeNull();
    const caido = (async () => { throw new Error('red'); }) as unknown as typeof fetch;
    expect(await crearVerificadorSupabase({ url: 'https://p', apiKey: 'a', fetch: caido })(token)).toBeNull();
  });
  it('crearEsAdminSql y crearContactosDesdeCaptacion', async () => {
    const sql = { query: async () => ({ rows: [{ admin: true }] }), transaction: async () => { throw new Error(); } } as unknown as SqlClient;
    expect(await crearEsAdminSql(sql)(ID)).toBe(true);
    const vacio = { query: async () => ({ rows: [] }) } as unknown as SqlClient;
    expect(await crearEsAdminSql(vacio)(ID)).toBe(false);
    const c = crearContactosDesdeCaptacion(async (_s, id) => (id === ID ? { telefonoE164: '528112345678' } : null), sql);
    expect(await c.telefonoDeLead(ID)).toBe('528112345678');
    expect(await c.telefonoDeLead('otro')).toBeNull();
  });
});
