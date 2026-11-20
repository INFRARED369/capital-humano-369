/**
 * Cierre backend · shared.fallar_definitivo: un error permanente (4xx de validación) va DIRECTO a dead letter,
 * sin gastar los reintentos con backoff (antes agotaba 3 intentos). Solo service_role.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../test/db/harness.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000);
afterEach(async () => { await db.close(); });

async function encolarYTomar(cola = 'zoho-sync'): Promise<string> {
  await db.servicio.query(`select shared.encolar($1, '{"cita_id":"c-1"}'::jsonb, 'k-1', 5::smallint, null, now(), 3::smallint)`, [cola]);
  const { rows } = await db.servicio.query<{ id: string }>(`select id::text as id from shared.tomar($1, 1, 60)`, [cola]);
  return rows[0]!.id;
}

describe('shared.fallar_definitivo', () => {
  it('en el 1.er intento mueve el item a dead letter con el motivo y devuelve dead_letter', async () => {
    const id = await encolarYTomar();
    const { rows } = await db.servicio.query<{ r: string }>(`select shared.fallar_definitivo($1::bigint, 'permanente 400: HTTP 400 INVALID_DATA') as r`, [id]);
    expect(rows[0]!.r).toBe('dead_letter');
    const cola = await db.sql.query<{ estado: string; intentos: number; ultimo_error: string }>(`select estado, intentos, ultimo_error from shared.cola where id = $1`, [id]);
    expect(cola.rows).toEqual([{ estado: 'dead_letter', intentos: 1, ultimo_error: 'permanente 400: HTTP 400 INVALID_DATA' }]);
    const dl = await db.sql.query<{ cola: string; motivo: string; payload: unknown }>(`select cola, motivo, payload from shared.dead_letter`);
    expect(dl.rows).toEqual([{ cola: 'zoho-sync', motivo: 'permanente 400: HTTP 400 INVALID_DATA', payload: { cita_id: 'c-1' } }]);
  });

  it('es idempotente: un item ya en dead letter o completado no se duplica', async () => {
    const id = await encolarYTomar();
    await db.servicio.query(`select shared.fallar_definitivo($1::bigint, 'x')`, [id]);
    const r2 = await db.servicio.query<{ r: string }>(`select shared.fallar_definitivo($1::bigint, 'x') as r`, [id]);
    expect(r2.rows[0]!.r).toBe('dead_letter');
    expect((await db.sql.query(`select 1 from shared.dead_letter`)).rows).toHaveLength(1);
    await db.servicio.query(`select shared.encolar('zoho-sync', '{}'::jsonb, 'k-2')`);
    const { rows } = await db.servicio.query<{ id: string }>(`select id::text as id from shared.tomar('zoho-sync', 1, 60)`);
    await db.servicio.query(`select shared.completar($1::bigint)`, [rows[0]!.id]);
    expect((await db.servicio.query<{ r: string }>(`select shared.fallar_definitivo($1::bigint, 'tarde') as r`, [rows[0]!.id])).rows[0]!.r).toBe('completado');
    expect((await db.sql.query(`select 1 from shared.dead_letter`)).rows).toHaveLength(1);
  });

  it('id inexistente → null; motivo truncado a 500', async () => {
    expect((await db.servicio.query<{ r: string | null }>(`select shared.fallar_definitivo(999999, 'x') as r`)).rows[0]!.r).toBeNull();
    const id = await encolarYTomar('otra');
    await db.servicio.query(`select shared.fallar_definitivo($1::bigint, $2)`, [id, 'e'.repeat(900)]);
    expect((await db.sql.query<{ n: number }>(`select length(motivo) as n from shared.dead_letter`)).rows[0]!.n).toBe(500);
  });

  it('anon y authenticated no pueden ejecutarla', async () => {
    await expect(db.como('anon', null, (s) => s.query(`select shared.fallar_definitivo(1, 'x')`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario('00000000-0000-4000-8000-000000000001', (s) => s.query(`select shared.fallar_definitivo(1, 'x')`))).rejects.toThrow(/permission denied/);
  });
});
