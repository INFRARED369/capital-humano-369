/**
 * Vacantes · config.guardar_reglas, auditoría y alta sin código contra PGlite.
 * S3 (cliente no edita), S4 / NFR-SEG-09 (quién, cuándo, diff), S1 (historial), NFR-ESC-06 y E2E-08 (nivel BD).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante } from '@test/db/fixtures';
import { obtenerSlots } from '@domains/citas/index.ts';
import { diffReglas } from '../domain/diff.ts';
import { PLANTILLA_VACANTE_DEFECTO, ReglasVacanteSchema } from '../domain/reglas.ts';
import { crearRepoReglasSql } from './sqlReglas.ts';

let db: TestDb;
let A: { vacanteId: string; clienteId: string };
let B: { vacanteId: string; clienteId: string };
let admin: string;
let reclutadorA: string;
let clienteA: string;

beforeEach(async () => {
  db = await crearTestDb();
  A = await crearVacante(db.sql, { slug: 'vac-a' });
  B = await crearVacante(db.sql, { slug: 'vac-b' });
  admin = await crearUsuario(db.sql, 'admin');
  reclutadorA = await crearUsuario(db.sql, 'reclutador', { clienteId: A.clienteId, vacantes: [A.vacanteId] });
  clienteA = await crearUsuario(db.sql, 'cliente', { clienteId: A.clienteId, vacantes: [A.vacanteId] });
}, 120_000);
afterEach(async () => { await db?.close(); });

const repo = () => crearRepoReglasSql(db.servicio);
const reglas = (parcial: unknown = {}) => ReglasVacanteSchema.parse(parcial);
const versiones = async (v: string) =>
  (await db.sql.query<{ version: number; creado_por: string | null }>('select version, creado_por from config.vacantes_reglas where vacante_id = $1 order by version', [v])).rows;
const auditoria = async (v: string) =>
  (await db.sql.query<{ version: number; usuario_id: string; diff: unknown; creado_en: string; cliente_id: string }>(
    'select version, usuario_id, diff, creado_en, cliente_id from config.vacantes_reglas_auditoria where vacante_id = $1 order by id', [v])).rows;

describe('guardar_reglas · permisos (S3, DSH-06)', () => {
  it('admin crea la versión 1 con creado_por = admin', async () => {
    const r = await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas(), versionBase: 0 });
    expect(r).toMatchObject({ ok: true, value: { version: 1, sinCambios: false } });
    expect(await versiones(A.vacanteId)).toEqual([{ version: 1, creado_por: admin }]);
  });

  it('reclutador asignado puede editar su vacante (decisión documentada)', async () => {
    const r = await repo().guardar({ usuarioId: reclutadorA }, { vacanteId: A.vacanteId, reglas: reglas({ agenda: { cupo_diario: 6 } }), versionBase: 0 });
    expect(r.ok).toBe(true);
  });

  it('S3: el rol cliente no puede editar reglas, ni de su propia vacante', async () => {
    const r = await repo().guardar({ usuarioId: clienteA }, { vacanteId: A.vacanteId, reglas: reglas(), versionBase: 0 });
    expect(r).toEqual({ ok: false, error: 'PERMISO_DENEGADO' });
    expect(await versiones(A.vacanteId)).toEqual([]);
    expect(await auditoria(A.vacanteId)).toEqual([]);
  });

  it('S1: reclutador de A no edita B; sin sesión tampoco', async () => {
    expect(await repo().guardar({ usuarioId: reclutadorA }, { vacanteId: B.vacanteId, reglas: reglas(), versionBase: 0 })).toEqual({ ok: false, error: 'PERMISO_DENEGADO' });
    expect(await repo().guardar({ usuarioId: null }, { vacanteId: A.vacanteId, reglas: reglas(), versionBase: 0 })).toEqual({ ok: false, error: 'PERMISO_DENEGADO' });
  });

  it('solo admin cambia el calendario de Zoho (un reclutador no puede redirigir eventos)', async () => {
    const r = await repo().guardar({ usuarioId: reclutadorA }, { vacanteId: A.vacanteId, reglas: reglas({ zoho_calendar_uid: 'calendario-propio' }), versionBase: 0 });
    expect(r).toEqual({ ok: false, error: 'PERMISO_DENEGADO' });
    expect((await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas({ zoho_calendar_uid: 'calendario-a1' }), versionBase: 0 })).ok).toBe(true);
    // el reclutador sí puede editar otras reglas conservando el calendario
    const r2 = await repo().guardar({ usuarioId: reclutadorA }, { vacanteId: A.vacanteId, reglas: reglas({ zoho_calendar_uid: 'calendario-a1', agenda: { cupo_diario: 4 } }), versionBase: 1 });
    expect(r2.ok).toBe(true);
  });

  it('S3 a nivel BD: authenticated no ejecuta guardar_reglas ni escribe config.vacantes_reglas directamente', async () => {
    for (const usuario of [clienteA, reclutadorA, admin]) {
      await expect(db.comoUsuario(usuario, (s) => s.query(`select config.guardar_reglas($1, '{}'::jsonb, 0)`, [A.vacanteId]))).rejects.toThrow(/permission denied/);
      await expect(
        db.comoUsuario(usuario, (s) => s.query(`insert into config.vacantes_reglas (vacante_id, version, cliente_id, reglas) values ($1, 99, $2, '{}')`, [A.vacanteId, A.clienteId])),
      ).rejects.toThrow(/permission denied/);
      await expect(db.comoUsuario(usuario, (s) => s.query(`insert into config.vacantes_reglas_auditoria (vacante_id, cliente_id, version, diff) values ($1, $2, 1, '[]')`, [A.vacanteId, A.clienteId]))).rejects.toThrow(/permission denied/);
    }
    await expect(db.como('anon', null, (s) => s.query(`select config.guardar_reglas($1, '{}'::jsonb, 0)`, [A.vacanteId]))).rejects.toThrow(/permission denied/);
  });

  it('vacante inexistente → NO_ENCONTRADA', async () => {
    expect(await repo().guardar({ usuarioId: admin }, { vacanteId: globalThis.crypto.randomUUID(), reglas: reglas(), versionBase: 0 })).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
  });
});

describe('guardar_reglas · versiones inmutables y auditoría (S4, NFR-SEG-09, C13)', () => {
  it('cada cambio crea una versión nueva y una fila de auditoría con quién, cuándo y diff', async () => {
    const v1 = reglas();
    const v2 = reglas({ agenda: { cupo_diario: 5, ventanas_inicio: [{ desde: '09:30', hasta: '13:00' }] } });
    await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: v1, versionBase: 0 });
    const r = await repo().guardar({ usuarioId: reclutadorA }, { vacanteId: A.vacanteId, reglas: v2, versionBase: 1 });
    expect(r.ok && r.value.version).toBe(2);
    expect(r.ok && r.value.diff).toEqual(diffReglas(v1, v2));

    const aud = await auditoria(A.vacanteId);
    expect(aud.map((a) => [a.version, a.usuario_id, a.cliente_id])).toEqual([[1, admin, A.clienteId], [2, reclutadorA, A.clienteId]]);
    expect(aud[1]!.diff).toEqual([
      { ruta: 'agenda.cupo_diario', antes: 10, despues: 5 },
      { ruta: 'agenda.ventanas_inicio', antes: v1.agenda.ventanas_inicio, despues: [{ desde: '09:30', hasta: '13:00' }] },
    ]);
    // el diff SQL de la primera versión es contra {} y coincide con el de TS (paridad)
    expect(aud[0]!.diff).toEqual(diffReglas({}, v1));
    expect(new Date(aud[1]!.creado_en).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('guardar las mismas reglas no crea versión ni auditoría (sinCambios)', async () => {
    await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas(), versionBase: 0 });
    const r = await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas(), versionBase: 1 });
    expect(r).toMatchObject({ ok: true, value: { version: 1, sinCambios: true, diff: [] } });
    expect(await auditoria(A.vacanteId)).toHaveLength(1);
  });

  it('control optimista: versión base desactualizada → VERSION_CONFLICTO', async () => {
    await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas(), versionBase: 0 });
    expect(await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas({ agenda: { cupo_diario: 3 } }), versionBase: 0 })).toEqual({ ok: false, error: 'VERSION_CONFLICTO' });
  });

  it('las versiones y la auditoría son inmutables (ni el dueño puede editarlas)', async () => {
    await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas(), versionBase: 0 });
    await expect(db.sql.query(`update config.vacantes_reglas set reglas = '{}' where vacante_id = $1`, [A.vacanteId])).rejects.toThrow(/inmutables/);
    await expect(db.sql.query(`update config.vacantes_reglas_auditoria set diff = '[]' where vacante_id = $1`, [A.vacanteId])).rejects.toThrow(/inmutable/);
    await expect(db.sql.query(`delete from config.vacantes_reglas_auditoria where vacante_id = $1`, [A.vacanteId])).rejects.toThrow(/inmutable/);
  });

  it('validación mínima en SQL: objeto, llaves conocidas, bloques objeto y ≤ 64 KB', async () => {
    const malas: unknown[] = ['"texto"', '[]', '{"otra":1}', '{"agenda":3}', '{"mensajes":"x"}', '{"zoho_calendar_uid":5}', JSON.stringify({ agenda: { x: 'y'.repeat(70_000) } })];
    for (const m of malas) {
      const r = await db.servicio
        .transaction(async (tx) => {
          await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin, role: 'authenticated' })]);
          return tx.query(`select config.guardar_reglas($1, $2::jsonb, 0)`, [A.vacanteId, m]);
        })
        .then(() => 'ok', (e: Error) => e.message);
      expect(r).toMatch(/REGLAS_INVALIDAS/);
    }
  });
});

describe('E2E-08 a nivel BD: los consumidores leen la versión nueva sin rebuild', () => {
  it('cupo 10 → 5 y sin tarde: citas.obtenerSlots ofrece solo la mañana con la versión nueva', async () => {
    const clock = new FixedClock(new Date('2026-11-17T02:00:00Z'));
    const r = await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: reglas({ agenda: { cupo_diario: 5, ventanas_inicio: [{ desde: '09:30', hasta: '13:00' }] } }), versionBase: 0 });
    expect(r.ok).toBe(true);
    const s = await obtenerSlots({ sql: db.servicio, clock }, A.vacanteId);
    expect(s.ok && s.value.reglasVersion).toBe(1);
    const martes = s.ok ? s.value.slots.filter((x) => x.fecha === '2026-11-17') : [];
    expect(martes.map((x) => x.horaLocal)).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00']);
  });
});

describe('alta sin código (NFR-ESC-06) · solo admin', () => {
  it('admin crea cliente, vacante con reglas iniciales y asigna un reclutador por correo', async () => {
    const c = await repo().crearCliente({ usuarioId: admin }, { nombre: 'Cliente Nuevo' });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const v = await repo().crearVacante({ usuarioId: admin }, { cliente_id: c.value.clienteId, slug: 'nueva-vacante', codigo: 'NV-1', nombre: 'Nueva', reglas: reglas({ agenda: { cupo_diario: 8 } }) });
    expect(v).toMatchObject({ ok: true, value: { version: 1 } });
    if (!v.ok) return;
    expect(await versiones(v.value.vacanteId)).toEqual([{ version: 1, creado_por: admin }]);
    expect(await auditoria(v.value.vacanteId)).toHaveLength(1);

    await db.sql.query(`insert into auth.users (id, email) values ($1, 'nueva@ejemplo.mx')`, [globalThis.crypto.randomUUID()]);
    const a = await repo().asignar({ usuarioId: admin }, { email: 'nueva@ejemplo.mx', rol: 'reclutador', vacante_id: v.value.vacanteId });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const ve = await db.comoUsuario(a.value.userId, (s) => s.query<{ slug: string }>('select slug from shared.vacantes order by slug'));
    expect(ve.rows.map((x) => x.slug)).toEqual(['nueva-vacante']);
    // idempotente
    expect((await repo().asignar({ usuarioId: admin }, { email: 'nueva@ejemplo.mx', rol: 'reclutador', vacante_id: v.value.vacanteId })).ok).toBe(true);
  });

  it('vacante sin reglas iniciales: versión null (los consumidores usan la plantilla)', async () => {
    const v = await repo().crearVacante({ usuarioId: admin }, { cliente_id: A.clienteId, slug: 'sin-reglas', codigo: 'SR', nombre: 'Sin reglas' });
    expect(v).toMatchObject({ ok: true, value: { version: null } });
  });

  it('slug o código duplicado → DUPLICADO; cliente inexistente → NO_ENCONTRADA; correo desconocido → USUARIO_NO_ENCONTRADO', async () => {
    expect(await repo().crearVacante({ usuarioId: admin }, { cliente_id: A.clienteId, slug: 'vac-a', codigo: 'OTRO', nombre: 'x' })).toEqual({ ok: false, error: 'DUPLICADO' });
    expect(await repo().crearVacante({ usuarioId: admin }, { cliente_id: globalThis.crypto.randomUUID(), slug: 'zz', codigo: 'ZZ', nombre: 'x' })).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    expect(await repo().asignar({ usuarioId: admin }, { email: 'nadie@ejemplo.mx', rol: 'cliente', vacante_id: A.vacanteId })).toEqual({ ok: false, error: 'USUARIO_NO_ENCONTRADO' });
  });

  it('reclutador y cliente no dan de alta nada', async () => {
    for (const u of [reclutadorA, clienteA]) {
      expect(await repo().crearCliente({ usuarioId: u }, { nombre: 'x' })).toEqual({ ok: false, error: 'PERMISO_DENEGADO' });
      expect(await repo().crearVacante({ usuarioId: u }, { cliente_id: A.clienteId, slug: 'x-y', codigo: 'XY', nombre: 'x' })).toEqual({ ok: false, error: 'PERMISO_DENEGADO' });
      expect(await repo().asignar({ usuarioId: u }, { email: 'x@y.mx', rol: 'cliente', vacante_id: A.vacanteId })).toEqual({ ok: false, error: 'PERMISO_DENEGADO' });
    }
  });
});

describe('historial de reglas para el panel (S1, S4)', () => {
  it('devuelve versión, autor (correo), fecha y diff; solo de vacantes visibles', async () => {
    await db.sql.query(`update auth.users set email = 'admin@ejemplo.mx' where id = $1`, [admin]);
    await repo().guardar({ usuarioId: admin }, { vacanteId: A.vacanteId, reglas: PLANTILLA_VACANTE_DEFECTO, versionBase: 0 });
    const h = await db.comoUsuario(clienteA, (s) => s.query<{ version: number; usuario_email: string; diff: unknown[] }>('select * from config.historial_reglas($1)', [A.vacanteId]));
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ version: 1, usuario_email: 'admin@ejemplo.mx' });
    expect(h.rows[0]!.diff.length).toBeGreaterThan(5);

    const reclB = await crearUsuario(db.sql, 'reclutador', { clienteId: B.clienteId, vacantes: [B.vacanteId] });
    const h2 = await db.comoUsuario(reclB, (s) => s.query('select * from config.historial_reglas($1)', [A.vacanteId]));
    expect(h2.rows).toEqual([]);
    await expect(db.como('anon', null, (s) => s.query('select * from config.historial_reglas($1)', [A.vacanteId]))).rejects.toThrow(/permission denied/);
  });
});
