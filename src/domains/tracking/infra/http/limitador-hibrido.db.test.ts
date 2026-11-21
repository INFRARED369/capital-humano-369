/** Contador global del limitador híbrido sobre shared.rate_limit (PGlite): agrega por /24 y no guarda IPs. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearContadorGlobalSql, crearLimitadorHibrido } from './limitador-hibrido.ts';
import { crearLimitadorMemoria } from './limitador.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000);
afterEach(async () => { await db.close(); });

describe('limitador híbrido + shared.rate_limit_sumar', () => {
  it('dos isolates suman en la misma llave HMAC; al pasar el límite global ambos bloquean la /24; la tabla no tiene IPs', async () => {
    // La ventana la calcula la BD con su now(): si la prueba cruza el cambio de minuto, el conteo se parte en dos
    // ventanas (10 + 10) y no bloquea. Se evita arrancar en los últimos 15 s del minuto.
    const restante = 60_000 - (Date.now() % 60_000);
    if (restante < 15_000) await new Promise((r) => setTimeout(r, restante + 100));
    const clock = new FixedClock(new Date());
    const isolate = () => crearLimitadorHibrido({
      local: crearLimitadorMemoria({ max: 1000, ventanaMs: 60_000 }, clock),
      contador: crearContadorGlobalSql(db.servicio, 'pepper-de-prueba-0123456789abcdef'),
      limiteGlobal: 15, ventanaMs: 60_000, loteEventos: 10, clock, log: crearLogger({}, () => {}),
    });
    const a = isolate();
    const b = isolate();
    for (let i = 0; i < 10; i++) a.permitir(`189.203.1.${i}`);
    for (let i = 0; i < 10; i++) b.permitir(`189.203.1.${i + 50}`);
    await a.vaciar();
    await b.vaciar();
    expect(b.permitir('189.203.1.99')).toBe(false);
    const { rows } = await db.sql.query<{ llave: string; conteo: number }>(`select llave, conteo from shared.rate_limit`);
    expect(rows).toEqual([{ llave: expect.stringMatching(/^trk-ip:[0-9a-f]{32}$/), conteo: 20 }]);
    expect(JSON.stringify(rows)).not.toContain('189.203');
  }, 30_000);
});
