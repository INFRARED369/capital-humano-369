import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearVacante } from '../../../../test/db/fixtures.ts';
import { crearCitasVigentesSql } from './citasVigentesSql.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); });
afterEach(async () => { await db.close(); });

async function cita(vacanteId: string, clienteId: string, inicio: string, estado: string) {
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into citas.citas (cliente_id, vacante_id, inicio, fin, dia_local, estado, reglas_version, expira_en)
     values ($1, $2, $3::timestamptz, $3::timestamptz + interval '90 minutes', ($3::timestamptz at time zone 'America/Mexico_City')::date, $4, 0, case when $4 = 'retenida' then $3::timestamptz end) returning id`,
    [clienteId, vacanteId, inicio, estado],
  );
  return rows[0]!.id;
}

describe('CitasVigentesPort sobre citas.citas (Z5)', () => {
  it('devuelve solo confirmadas dentro de [desde, hasta)', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const dentro = await cita(vacanteId, clienteId, '2026-12-01T16:00:00Z', 'confirmada');
    await cita(vacanteId, clienteId, '2026-12-01T17:00:00Z', 'cancelada');
    await cita(vacanteId, clienteId, '2026-12-01T18:00:00Z', 'retenida');
    await cita(vacanteId, clienteId, '2026-12-10T16:00:00Z', 'confirmada');
    const r = await crearCitasVigentesSql(db.sql).vigentes({ desde: '2026-12-01T00:00:00Z', hasta: '2026-12-05T00:00:00Z' });
    expect(r).toEqual([{ citaId: dentro, inicio: '2026-12-01T16:00:00.000Z', fin: '2026-12-01T17:30:00.000Z' }]);
  });
});
