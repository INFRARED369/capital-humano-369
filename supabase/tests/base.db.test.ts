import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../test/db/harness';
import { crearUsuario, crearVacante } from '../../test/db/fixtures';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); });
afterEach(async () => { await db.close(); });

describe('S2 · anon no puede consultar ninguna tabla de dominio', () => {
  it('toda tabla de los schemas de dominio tiene RLS habilitado', async () => {
    const { rows } = await db.sql.query<{ tabla: string }>(`
      select n.nspname || '.' || c.relname as tabla from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and not c.relispartition and n.nspname in ('shared','config','captacion','citas','comunicacion','tracking','dashboard','privacidad')
        and not c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it('anon recibe permiso denegado en cada tabla', async () => {
    const { rows } = await db.sql.query<{ tabla: string }>(`
      select n.nspname || '.' || c.relname as tabla from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and n.nspname in ('shared','config','captacion','citas','comunicacion','tracking','dashboard','privacidad')`);
    expect(rows.length).toBeGreaterThan(0);
    for (const { tabla } of rows) {
      await expect(db.como('anon', null, (s) => s.query(`select * from ${tabla} limit 1`)), tabla).rejects.toThrow(/permission denied/);
    }
  });
});

describe('cola con prioridad e idempotencia', () => {
  it('encolar con la misma llave devuelve el mismo id; tomar respeta prioridad', async () => {
    const a = await db.sql.query<{ id: string }>(`select shared.encolar('t', '{"n":1}', 'k1', 5::smallint) as id`);
    const b = await db.sql.query<{ id: string }>(`select shared.encolar('t', '{"n":1}', 'k1', 5::smallint) as id`);
    expect(a.rows[0]!.id).toBe(b.rows[0]!.id);
    await db.sql.query(`select shared.encolar('t', '{"n":2}', 'k2', 0::smallint)`);
    const { rows } = await db.sql.query<{ llave_idempotencia: string }>(`select * from shared.tomar('t', 1, 60)`);
    expect(rows[0]!.llave_idempotencia).toBe('k2');
  });

  it('tras agotar max_intentos el mensaje va a dead letter', async () => {
    await db.sql.query(`select shared.encolar('t', '{}', 'k', 5::smallint, null, now(), 2::smallint)`);
    for (const esperado of ['reintento', 'dead_letter']) {
      await db.sql.query(`update shared.cola set visible_desde = now() where llave_idempotencia = 'k'`);
      const { rows: [m] } = await db.sql.query<{ id: string }>(`select id from shared.tomar('t', 1, 60)`);
      const { rows: [r] } = await db.sql.query<{ r: string }>(`select shared.fallar($1, 'boom', 0) as r`, [m!.id]);
      expect(r!.r).toBe(esperado);
    }
    const { rows } = await db.sql.query(`select * from shared.dead_letter`);
    expect(rows).toHaveLength(1);
  });
});

describe('reglas versionadas e inmutables', () => {
  it('no permite modificar una versión existente', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await db.sql.query(`insert into config.vacantes_reglas (vacante_id, version, cliente_id, reglas) values ($1, 1, $2, '{}')`, [vacanteId, clienteId]);
    await expect(db.sql.query(`update config.vacantes_reglas set reglas = '{"x":1}'`)).rejects.toThrow(/inmutables/);
  });

  it('un reclutador solo ve sus vacantes', async () => {
    const a = await crearVacante(db.sql, { slug: 'a' });
    const b = await crearVacante(db.sql, { slug: 'b' });
    const u = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const { rows } = await db.comoUsuario(u, (s) => s.query<{ slug: string }>('select slug from shared.vacantes'));
    expect(rows.map((r) => r.slug)).toEqual(['a']);
    expect(b).toBeTruthy();
  });
});

describe('endurecimiento: funciones de cola/outbox', () => {
  it('authenticated y anon no pueden encolar ni leer el outbox', async () => {
    for (const rol of ['anon', 'authenticated'] as const) {
      await expect(db.como(rol, { sub: '00000000-0000-0000-0000-000000000001' }, (s) => s.query(`select shared.encolar('t', '{}', 'x')`))).rejects.toThrow(/permission denied/);
      await expect(db.como(rol, { sub: '00000000-0000-0000-0000-000000000001' }, (s) => s.query(`select * from shared.leer_outbox('c', array['LeadCreado'])`))).rejects.toThrow(/permission denied/);
    }
  });
  it('service_role sí puede', async () => {
    const { rows } = await db.servicio.query<{ id: string }>(`select shared.encolar('t', '{}', 'x') as id`);
    expect(rows[0]!.id).toBeTruthy();
  });
});
