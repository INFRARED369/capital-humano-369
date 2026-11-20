/** Rate limit basado en tabla (NFR-SEG-03): ventana fija, atómico, sin PII y solo para service_role. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../test/db/harness.ts';
import { consumirCupo } from './rate-limit.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); });
afterEach(async () => { await db.close(); });

const consumir = (ahora: string, llave = 'otp-ip:abc', limite = 3, ventana = 60) =>
  db.servicio.query<{ permitido: boolean; conteo: number; reinicia_en: Date }>(
    `select * from shared.rate_limit_consumir($1, $2, $3, $4::timestamptz)`, [llave, limite, ventana, ahora]);

describe('shared.rate_limit_consumir', () => {
  it('permite hasta el límite dentro de la ventana y luego niega', async () => {
    const res = [];
    for (let i = 0; i < 4; i++) res.push((await consumir('2026-11-13T10:00:10Z')).rows[0]!);
    expect(res.map((r) => r.permitido)).toEqual([true, true, true, false]);
    expect(res.map((r) => r.conteo)).toEqual([1, 2, 3, 4]);
    expect(new Date(res[3]!.reinicia_en).toISOString()).toBe('2026-11-13T10:01:00.000Z');
  });

  it('la ventana siguiente reinicia el conteo; llaves distintas son independientes', async () => {
    for (let i = 0; i < 3; i++) await consumir('2026-11-13T10:00:10Z');
    expect((await consumir('2026-11-13T10:01:00Z')).rows[0]!.permitido).toBe(true);
    expect((await consumir('2026-11-13T10:00:10Z', 'otro')).rows[0]!.conteo).toBe(1);
  });

  it('purgar borra ventanas vencidas', async () => {
    await consumir('2026-11-13T10:00:10Z');
    await consumir('2026-11-13T12:00:10Z', 'k2');
    const { rows } = await db.servicio.query<{ n: number }>(`select shared.rate_limit_purgar('2026-11-13T11:00:00Z'::timestamptz) as n`);
    expect(rows[0]!.n).toBe(1);
    expect((await db.sql.query(`select llave from shared.rate_limit`)).rows).toEqual([{ llave: 'k2' }]);
  });

  it('anon y authenticated no pueden ejecutarla ni leer la tabla', async () => {
    await expect(db.como('anon', null, (s) => s.query(`select shared.rate_limit_consumir('x', 1, 60)`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario('00000000-0000-4000-8000-000000000001', (s) => s.query(`select shared.rate_limit_consumir('x', 1, 60)`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario('00000000-0000-4000-8000-000000000001', (s) => s.query(`select * from shared.rate_limit`))).rejects.toThrow(/permission denied/);
  });

  it('consumirCupo (TS) sobre la función real', async () => {
    const r1 = await consumirCupo(db.servicio, { llave: 'ts', limite: 1, ventanaSeg: 3600 });
    const r2 = await consumirCupo(db.servicio, { llave: 'ts', limite: 1, ventanaSeg: 3600 });
    expect(r1).toMatchObject({ permitido: true, restantes: 0 });
    expect(r2.permitido).toBe(false);
    expect(r2.reintentarEnSeg).toBeGreaterThan(0);
  });

  it('las tareas de cron no se programan sin pg_cron (PGlite) y la migración aplica igual', async () => {
    const { rows } = await db.sql.query(`select 1 from pg_namespace where nspname = 'cron'`);
    expect(rows).toEqual([]);
  });
});

describe('shared.rate_limit_sumar (lotes del limitador híbrido de tracking-ingest)', () => {
  const sumar = (llaves: string[], inc: number[], ahora = '2026-11-13T10:00:10Z') =>
    db.servicio.query<{ llave: string; conteo: number }>(`select llave, conteo from shared.rate_limit_sumar($1::text[], $2::int[], 60, $3::timestamptz) order by llave`, [llaves, inc, ahora]);

  it('suma incrementos por llave en una sola consulta y devuelve el total de la ventana', async () => {
    expect((await sumar(['ti:a', 'ti:b'], [30, 5])).rows).toEqual([{ llave: 'ti:a', conteo: 30 }, { llave: 'ti:b', conteo: 5 }]);
    expect((await sumar(['ti:a'], [12])).rows).toEqual([{ llave: 'ti:a', conteo: 42 }]);
    expect((await sumar(['ti:a'], [1], '2026-11-13T10:01:00Z')).rows).toEqual([{ llave: 'ti:a', conteo: 1 }]);
  });

  it('rechaza arreglos de distinto largo o incrementos no positivos; solo service_role', async () => {
    await expect(sumar(['a', 'b'], [1])).rejects.toThrow(/rate_limit/);
    await expect(sumar(['a'], [0])).rejects.toThrow(/rate_limit/);
    await expect(db.como('anon', null, (s) => s.query(`select * from shared.rate_limit_sumar(array['x'], array[1], 60)`))).rejects.toThrow(/permission denied/);
  });
});
