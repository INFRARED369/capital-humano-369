/**
 * Edge function panel-reglas: handler puro (Request → Response) contra PGlite real y verificador falso.
 * DSH-04/06, S3, S4, NFR-ESC-06, NFR-SEG-09. El verificador real de Supabase Auth se prueba aparte.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante } from '@test/db/fixtures';
import { crearRepoReglasSql } from '../sqlReglas.ts';
import { crearHandlerPanelReglas } from './panelReglas.ts';

const ORIGEN = 'https://369capitalhumano.com';
let db: TestDb;
let A: { vacanteId: string; clienteId: string };
let tokens: Record<string, string>;
let lineas: string[];
let handler: (req: Request) => Promise<Response>;
let permitir = true;

beforeEach(async () => {
  db = await crearTestDb();
  A = await crearVacante(db.sql, { slug: 'vac-a' });
  const admin = await crearUsuario(db.sql, 'admin');
  const clienteA = await crearUsuario(db.sql, 'cliente', { clienteId: A.clienteId, vacantes: [A.vacanteId] });
  tokens = { 'tok-admin': admin, 'tok-cliente': clienteA };
  lineas = [];
  permitir = true;
  handler = crearHandlerPanelReglas({
    repo: crearRepoReglasSql(db.servicio),
    sesion: { verificar: async (t) => (tokens[t] ? { usuarioId: tokens[t]! } : null) },
    allowedOrigin: [ORIGEN],
    limitador: { permitir: async () => (permitir ? { ok: true, reintentarEnSeg: 0 } : { ok: false, reintentarEnSeg: 30 }) },
    sink: (l) => lineas.push(l),
  });
}, 120_000);
afterEach(async () => { await db?.close(); });

function post(cuerpo: unknown, opts: { token?: string | null; origen?: string; tipo?: string; metodo?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': opts.tipo ?? 'application/json', origin: opts.origen ?? ORIGEN };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? 'tok-admin'}`;
  return new Request('https://x.supabase.co/functions/v1/panel-reglas', {
    method: opts.metodo ?? 'POST',
    headers,
    body: opts.metodo === 'GET' ? undefined : typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
}

const guardar = (reglas: unknown, version_base = 0) => ({ operacion: 'guardar_reglas', datos: { vacante_id: A.vacanteId, reglas, version_base } });

describe('panel-reglas · guardar_reglas', () => {
  it('admin guarda: 200 con versión, reglas normalizadas y diff; queda auditado (S4)', async () => {
    const res = await handler(post(guardar({ agenda: { cupo_diario: 5 } })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; reglas: { agenda: { cupo_diario: number; intervalo_min: number } }; diff: unknown[]; sin_cambios: boolean };
    expect(body.version).toBe(1);
    expect(body.reglas.agenda).toMatchObject({ cupo_diario: 5, intervalo_min: 30 });
    expect(body.diff.length).toBeGreaterThan(0);
    expect(body.sin_cambios).toBe(false);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    const { rows } = await db.sql.query<{ n: number }>('select count(*)::int as n from config.vacantes_reglas_auditoria');
    expect(rows[0]!.n).toBe(1);
  });

  it('S3: rol cliente → 403 y nada se guarda', async () => {
    const res = await handler(post(guardar({}), { token: 'tok-cliente' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'PERMISO_DENEGADO' });
  });

  it('Zod en el servidor: reglas inválidas → 422 con problemas por ruta, sin llegar a la BD', async () => {
    const res = await handler(post(guardar({ agenda: { cupo_diario: 0 } })));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; problemas: Array<{ ruta: string }> };
    expect(body.error).toBe('REGLAS_INVALIDAS');
    expect(body.problemas.map((p) => p.ruta)).toEqual(['agenda.cupo_diario']);
  });

  it('versión base desactualizada → 409 VERSION_CONFLICTO', async () => {
    await handler(post(guardar({})));
    const res = await handler(post(guardar({ agenda: { cupo_diario: 3 } }, 0)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'VERSION_CONFLICTO' });
  });

  it('vacante inexistente → 404', async () => {
    const res = await handler(post({ operacion: 'guardar_reglas', datos: { vacante_id: globalThis.crypto.randomUUID(), reglas: {}, version_base: 0 } }));
    expect(res.status).toBe(404);
  });
});

describe('panel-reglas · alta sin código (NFR-ESC-06)', () => {
  it('admin crea cliente y vacante con reglas iniciales', async () => {
    const c = await handler(post({ operacion: 'crear_cliente', datos: { nombre: 'Cliente X' } }));
    expect(c.status).toBe(201);
    const { cliente_id } = (await c.json()) as { cliente_id: string };
    const v = await handler(post({ operacion: 'crear_vacante', datos: { cliente_id, slug: 'vac-x', codigo: 'VX', nombre: 'Vacante X', reglas: {} } }));
    expect(v.status).toBe(201);
    expect(await v.json()).toMatchObject({ vacante_id: expect.any(String), version: 1 });
    const dup = await handler(post({ operacion: 'crear_vacante', datos: { cliente_id, slug: 'vac-x', codigo: 'VX2', nombre: 'Otra' } }));
    expect(dup.status).toBe(409);
  });

  it('asignar usuario: correo desconocido → 404; entrada inválida → 400 con problemas', async () => {
    const r = await handler(post({ operacion: 'asignar_usuario', datos: { email: 'nadie@x.mx', rol: 'reclutador', vacante_id: A.vacanteId } }));
    expect(r.status).toBe(404);
    const r2 = await handler(post({ operacion: 'asignar_usuario', datos: { email: 'x', rol: 'reclutador', vacante_id: A.vacanteId } }));
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { problemas: unknown[] }).problemas.length).toBe(1);
    const r3 = await handler(post({ operacion: 'crear_cliente', datos: { nombre: 'x' } }, { token: 'tok-cliente' }));
    expect(r3.status).toBe(403);
  });
});

describe('panel-reglas · borde HTTP', () => {
  it('sin Authorization → 401 SIN_SESION; token inválido → 401 SESION_INVALIDA', async () => {
    const r1 = await handler(post(guardar({}), { token: null }));
    expect(r1.status).toBe(401);
    expect(await r1.json()).toEqual({ error: 'SIN_SESION' });
    const r2 = await handler(post(guardar({}), { token: 'falso' }));
    expect(r2.status).toBe(401);
    expect(await r2.json()).toEqual({ error: 'SESION_INVALIDA' });
  });

  it('OPTIONS 204, método 405, origen ajeno 403, content-type 415, JSON roto 400, operación desconocida 400, cuerpo grande 413, 429', async () => {
    const opt = await handler(new Request('https://x/panel-reglas', { method: 'OPTIONS', headers: { origin: ORIGEN } }));
    expect(opt.status).toBe(204);
    expect(opt.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect((await handler(post(null, { metodo: 'GET' }))).status).toBe(405);
    expect((await handler(post(guardar({}), { origen: 'https://malo.example' }))).status).toBe(403);
    expect((await handler(post(guardar({}), { tipo: 'text/plain' }))).status).toBe(415);
    expect((await handler(post('{no json'))).status).toBe(400);
    expect((await handler(post({ operacion: 'borrar_todo', datos: {} }))).status).toBe(400);
    expect((await handler(post(guardar({ x: 'y'.repeat(200_000) })))).status).toBe(413);
    permitir = false;
    const lim = await handler(post(guardar({})));
    expect(lim.status).toBe(429);
    expect(lim.headers.get('retry-after')).toBe('30');
  });

  it('errores inesperados → 500 genérico sin detalles; logs sin el contenido de las reglas', async () => {
    const roto = crearHandlerPanelReglas({
      repo: { ...crearRepoReglasSql(db.servicio), guardar: async () => { throw new Error('conexión caída a postgres://secreto'); } },
      sesion: { verificar: async () => ({ usuarioId: tokens['tok-admin']! }) },
      allowedOrigin: [ORIGEN],
      sink: (l) => lineas.push(l),
    });
    const res = await roto(post(guardar({ mensajes: { plantillas: { confirmacion: { texto: 'texto-unico-xyz' } } } })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'ERROR_INTERNO' });
    expect(lineas.join('\n')).not.toMatch(/texto-unico-xyz|tok-admin/);
  });
});
