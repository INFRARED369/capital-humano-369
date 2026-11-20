/** Esquema y seguridad de citas.zoho_eventos / citas.zoho_alertas (S2, NFR-SEG-06, DSH-06). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante } from '@test/db/fixtures';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 60_000);
afterEach(async () => { await db.close(); });

const uuid = () => globalThis.crypto.randomUUID();

async function sembrar(vacanteId: string, clienteId: string, over: Record<string, unknown> = {}) {
  const citaId = uuid();
  const fila = { cita_id: citaId, cliente_id: clienteId, vacante_id: vacanteId, lead_id: uuid(), zoho_calendar_uid: 'cal1', uid_propio: `cita-${citaId}`,
    inicio: '2026-11-16T16:00:00Z', fin: '2026-11-16T16:30:00Z', folio: 'V-1', nombre_pila: 'Ana', ...over };
  const cols = Object.keys(fila);
  await db.sql.query(`insert into citas.zoho_eventos (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(fila));
  await db.sql.query(`insert into citas.zoho_alertas (cliente_id, vacante_id, cita_id, tipo, detalle) values ($1, $2, $3, 'ZOHO_DRIFT', '{}')`, [clienteId, vacanteId, citaId]);
  return citaId;
}

describe('citas.zoho_eventos / zoho_alertas · RLS', () => {
  it('tienen RLS y anon no puede leerlas', async () => {
    const { rows } = await db.sql.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'citas'::regnamespace and relname like 'zoho_%' and relkind = 'r' order by relname`);
    expect(rows).toEqual([
      { relname: 'zoho_alertas', relrowsecurity: true }, { relname: 'zoho_eventos', relrowsecurity: true }, { relname: 'zoho_token_cache', relrowsecurity: true },
    ]);
    for (const t of ['citas.zoho_eventos', 'citas.zoho_alertas', 'citas.zoho_token_cache']) {
      await expect(db.como('anon', null, (s) => s.query(`select * from ${t}`))).rejects.toThrow(/permission denied/);
    }
  });

  it('el reclutador solo ve los eventos y alertas de sus vacantes; no puede escribir', async () => {
    const a = await crearVacante(db.sql, { slug: 'a' });
    const b = await crearVacante(db.sql, { slug: 'b' });
    const citaA = await sembrar(a.vacanteId, a.clienteId);
    await sembrar(b.vacanteId, b.clienteId);
    const u = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const ev = await db.comoUsuario(u, (s) => s.query<{ cita_id: string }>('select cita_id from citas.zoho_eventos'));
    expect(ev.rows.map((r) => r.cita_id)).toEqual([citaA]);
    const al = await db.comoUsuario(u, (s) => s.query<{ cita_id: string }>('select cita_id from citas.zoho_alertas'));
    expect(al.rows.map((r) => r.cita_id)).toEqual([citaA]);
    await expect(db.comoUsuario(u, (s) => s.query(`update citas.zoho_eventos set folio = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(u, (s) => s.query(`delete from citas.zoho_alertas`))).rejects.toThrow(/permission denied/);
  });

  it('el admin ve todo', async () => {
    const a = await crearVacante(db.sql, { slug: 'a' });
    const b = await crearVacante(db.sql, { slug: 'b' });
    await sembrar(a.vacanteId, a.clienteId);
    await sembrar(b.vacanteId, b.clienteId);
    const admin = await crearUsuario(db.sql, 'admin');
    const { rows } = await db.comoUsuario(admin, (s) => s.query('select * from citas.zoho_eventos'));
    expect(rows).toHaveLength(2);
  });

  it('restricciones: estado válido, fin > inicio, uid_propio único, tipo de alerta válido', async () => {
    const a = await crearVacante(db.sql);
    await expect(sembrar(a.vacanteId, a.clienteId, { estado_sync: 'raro' })).rejects.toThrow();
    await expect(sembrar(a.vacanteId, a.clienteId, { fin: '2026-11-16T15:00:00Z' })).rejects.toThrow();
    await sembrar(a.vacanteId, a.clienteId, { uid_propio: 'dup' });
    await expect(sembrar(a.vacanteId, a.clienteId, { uid_propio: 'dup' })).rejects.toThrow();
    await expect(db.sql.query(`insert into citas.zoho_alertas (cliente_id, tipo) values ($1, 'OTRA')`, [a.clienteId])).rejects.toThrow();
  });
});
