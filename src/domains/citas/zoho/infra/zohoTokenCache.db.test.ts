/** Caché del access token de Zoho en BD, cifrado (AES-GCM con llave derivada de ZOHO_CLIENT_SECRET). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearTokenCacheSql } from './zohoTokenCache.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000);
afterEach(async () => { await db.close(); });

describe('citas.zoho_token_cache', () => {
  it('guarda cifrado (nunca en claro), lee de vuelta y reemplaza la única fila', async () => {
    const c = crearTokenCacheSql(db.servicio, 'csecret-xyz');
    expect(await c.leer()).toBeNull();
    await c.guardar('1000.ACCESS.aaa', 1_800_000_000_000);
    await c.guardar('1000.ACCESS.bbb', 1_800_000_100_000);
    expect(await c.leer()).toEqual({ token: '1000.ACCESS.bbb', venceEn: 1_800_000_100_000 });
    const { rows } = await db.sql.query<{ token_cifrado: string }>(`select token_cifrado from citas.zoho_token_cache`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_cifrado).not.toContain('ACCESS');
  });

  it('con otro secreto (rotación de ZOHO_CLIENT_SECRET) no se puede descifrar → null', async () => {
    await crearTokenCacheSql(db.servicio, 'csecret-xyz').guardar('1000.ACCESS.aaa', 1_800_000_000_000);
    expect(await crearTokenCacheSql(db.servicio, 'otro-secreto').leer()).toBeNull();
  });

  it('anon y authenticated no leen la tabla', async () => {
    await expect(db.como('anon', null, (s) => s.query(`select * from citas.zoho_token_cache`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario('00000000-0000-4000-8000-000000000001', (s) => s.query(`select * from citas.zoho_token_cache`))).rejects.toThrow(/permission denied/);
  });
});
