/**
 * Citas · BD y seguridad (C11, C12, C14 en SQL, S1, S2, CIT-05, CIT-06, CIT-10, vista de ocupación).
 * Las llamadas a citas.retener reciben los datos ya validados por el dominio (TS).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante } from '@test/db/fixtures';
import type { SqlClient } from '@shared/sql.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000); // la 1.ª vez construye la plantilla con todas las migraciones
afterEach(async () => { await db?.close(); });

const AHORA = '2026-11-17T02:00:00Z';
const lead = () => globalThis.crypto.randomUUID();

interface Retener { vacante: string; inicio: string; lead?: string; capacidad?: number; cupo?: number; empalmes?: boolean; ahora?: string; expira?: string; estado?: string }
async function retener(sql: SqlClient, o: Retener) {
  const inicio = new Date(o.inicio);
  const fin = new Date(inicio.getTime() + 90 * 60_000);
  const dia = new Date(inicio.getTime() - 6 * 3600_000).toISOString().slice(0, 10);
  const { rows } = await sql.query<{ r: { resultado: string; cita_id?: string; cliente_id?: string } }>(
    `select citas.retener($1, $2, $3::timestamptz, $4::timestamptz, $5::date, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12) as r`,
    [o.vacante, o.lead ?? lead(), inicio.toISOString(), fin.toISOString(), dia, o.capacidad ?? 1, o.cupo ?? 10, o.empalmes ?? true, 3,
      o.expira ?? '2026-11-17T02:10:00Z', o.ahora ?? AHORA, o.estado ?? 'retenida'],
  );
  return rows[0]!.r;
}

const eventos = async (tipo: string) =>
  (await db.sql.query<{ payload: Record<string, unknown> }>(`select payload from shared.outbox where tipo = $1 order by id`, [tipo])).rows.map((r) => r.payload);

describe('esquema citas.citas', () => {
  it('índice (vacante_id, inicio) para GET slots (NFR-ESC-05)', async () => {
    const { rows } = await db.sql.query<{ def: string }>(`select indexdef as def from pg_indexes where schemaname = 'citas' and tablename = 'citas'`);
    expect(rows.some((r) => /\(vacante_id, inicio\)/.test(r.def))).toBe(true);
  });

  it('S2 · RLS habilitado y anon sin acceso a tabla, vista ni funciones', async () => {
    const { rows } = await db.sql.query<{ rls: boolean }>(`select relrowsecurity as rls from pg_class where oid = 'citas.citas'::regclass`);
    expect(rows[0]!.rls).toBe(true);
    await expect(db.como('anon', null, (s) => s.query('select * from citas.citas'))).rejects.toThrow(/permission denied/);
    await expect(db.como('anon', null, (s) => s.query('select * from citas.api_ocupacion_diaria'))).rejects.toThrow(/permission denied/);
    await expect(db.como('anon', null, (s) => s.query(`select citas.registrar_asistencia(gen_random_uuid(), true, null)`))).rejects.toThrow(/permission denied/);
  });

  it('authenticated no puede escribir directamente ni llamar funciones internas', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const u = await crearUsuario(db.sql, 'admin');
    await expect(db.comoUsuario(u, (s) => retener(s, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z' }))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(u, (s) => s.query(`update citas.citas set estado = 'asistio'`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(u, (s) => s.query(`select citas.expirar_retenciones(now())`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(u, (s) => s.query(`select citas.suprimir_lead(gen_random_uuid())`))).rejects.toThrow(/permission denied/);
  });
});

describe('citas.retener · reserva atómica (CIT-05, CIT-06)', () => {
  it('inserta la retención con versión de reglas, día local y publica CitaRetenida', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const l = lead();
    const r = await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z', lead: l });
    expect(r.resultado).toBe('OK');
    const { rows } = await db.sql.query<Record<string, unknown>>(`select * from citas.citas where id = $1`, [r.cita_id]);
    expect(rows[0]).toMatchObject({ estado: 'retenida', reglas_version: 3, cliente_id: clienteId, lead_id: l });
    expect((rows[0]!.dia_local as Date).toISOString().slice(0, 10)).toBe('2026-11-17');
    expect(await eventos('CitaRetenida')).toEqual([
      { cita_id: r.cita_id, lead_id: l, vacante_id: vacanteId, cliente_id: clienteId, inicio: '2026-11-17T16:00:00.000Z', expira_en: '2026-11-17T02:10:00.000Z' },
    ]);
  });

  it('C4 en SQL · capacidad 1 → SLOT_LLENO; C8 empalme permitido en otro inicio', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    expect((await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z' })).resultado).toBe('OK');
    expect((await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z' })).resultado).toBe('SLOT_LLENO');
    expect((await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:30:00Z' })).resultado).toBe('OK');
    // sin empalmes, 17:00 se traslapa con la de 16:30 (90 min)
    expect((await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T17:00:00Z', empalmes: false })).resultado).toBe('SLOT_LLENO');
  });

  it('C6/C7 en SQL · cupo diario por vacante; otra vacante el mismo día sí reserva', async () => {
    const a = await crearVacante(db.sql);
    const b = await crearVacante(db.sql);
    for (let i = 0; i < 2; i++) {
      expect((await retener(db.servicio, { vacante: a.vacanteId, inicio: `2026-11-17T1${6 + i}:00:00Z`, cupo: 2 })).resultado).toBe('OK');
    }
    expect((await retener(db.servicio, { vacante: a.vacanteId, inicio: '2026-11-17T21:00:00Z', cupo: 2 })).resultado).toBe('CUPO_DIARIO');
    expect((await retener(db.servicio, { vacante: b.vacanteId, inicio: '2026-11-17T21:00:00Z', cupo: 2 })).resultado).toBe('OK');
  });

  it('C11 · 2 peticiones concurrentes al último lugar → exactamente 1 éxito', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const intentos = await Promise.all(
      [0, 1].map(() => db.servicio.transaction((tx) => retener(tx, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z' }))),
    );
    expect(intentos.map((r) => r.resultado).sort()).toEqual(['OK', 'SLOT_LLENO']);
    const { rows } = await db.sql.query<{ n: number }>(`select count(*)::int as n from citas.citas where vacante_id = $1`, [vacanteId]);
    expect(rows[0]!.n).toBe(1);
  });

  it('C11 · toma un advisory lock transaccional por (vacante, día)', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const locks = await db.servicio.transaction(async (tx) => {
      await retener(tx, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z' });
      return (await tx.query<{ n: number }>(`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`)).rows[0]!.n;
    });
    expect(locks).toBe(1);
    const despues = await db.sql.query<{ n: number }>(`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
    expect(despues.rows[0]!.n).toBe(0);
  });

  it('C12 · una retención vencida no cuenta y queda expirada con CitaExpirada', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r1 = await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z' });
    const r2 = await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z', ahora: '2026-11-17T02:11:00Z', expira: '2026-11-17T02:21:00Z' });
    expect(r2.resultado).toBe('OK');
    const { rows } = await db.sql.query<{ estado: string; motivo: string }>(`select estado, motivo from citas.citas where id = $1`, [r1.cita_id]);
    expect(rows[0]).toEqual({ estado: 'expirada', motivo: 'ttl' });
    expect((await eventos('CitaExpirada')).map((e) => e.cita_id)).toEqual([r1.cita_id]);
  });

  it('un lead con nueva retención en la misma vacante libera la anterior; con cita confirmada no puede retener otra', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const l = lead();
    const r1 = await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z', lead: l });
    const r2 = await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:30:00Z', lead: l });
    expect(r2.resultado).toBe('OK');
    const { rows } = await db.sql.query<{ estado: string }>(`select estado from citas.citas where id = $1`, [r1.cita_id]);
    expect(rows[0]!.estado).toBe('expirada');
    await db.sql.query(`update citas.citas set estado = 'confirmada', expira_en = null where id = $1`, [r2.cita_id]);
    expect((await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T17:00:00Z', lead: l })).resultado).toBe('CITA_ACTIVA');
  });

  it('vacante inexistente o estado no permitido', async () => {
    expect((await retener(db.servicio, { vacante: globalThis.crypto.randomUUID(), inicio: '2026-11-17T16:00:00Z' })).resultado).toBe('VACANTE_NO_ENCONTRADA');
    const { vacanteId } = await crearVacante(db.sql);
    await expect(retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z', estado: 'asistio' })).rejects.toThrow(/p_estado/);
  });
});

describe('citas.expirar_retenciones (C12 por cron)', () => {
  it('expira solo las vencidas, es idempotente y respeta el filtro por vacante', async () => {
    const a = await crearVacante(db.sql);
    const b = await crearVacante(db.sql);
    await retener(db.servicio, { vacante: a.vacanteId, inicio: '2026-11-17T16:00:00Z' });
    await retener(db.servicio, { vacante: b.vacanteId, inicio: '2026-11-17T16:00:00Z' });
    await retener(db.servicio, { vacante: b.vacanteId, inicio: '2026-11-17T17:00:00Z', expira: '2026-11-17T03:00:00Z' });
    const n = async (ahora: string, v: string | null) =>
      (await db.servicio.query<{ n: number }>(`select citas.expirar_retenciones($1::timestamptz, $2::uuid) as n`, [ahora, v])).rows[0]!.n;
    expect(await n('2026-11-17T02:11:00Z', a.vacanteId)).toBe(1);
    expect(await n('2026-11-17T02:11:00Z', null)).toBe(1);
    expect(await n('2026-11-17T02:11:00Z', null)).toBe(0);
    expect(await eventos('CitaExpirada')).toHaveLength(2);
  });
});

describe('citas.registrar_asistencia (CIT-10, C14 en SQL)', () => {
  async function citaConfirmada(vacanteId: string) {
    const r = await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z', estado: 'confirmada' });
    return r.cita_id!;
  }

  it('el reclutador asignado registra asistencia; publica AsistenciaRegistrada con event_id', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const cita = await citaConfirmada(vacanteId);
    const u = await crearUsuario(db.sql, 'reclutador', { clienteId, vacantes: [vacanteId] });
    const { rows } = await db.comoUsuario(u, (s) =>
      s.query<{ r: { estado: string; event_id: string } }>(`select citas.registrar_asistencia($1, true, '{"calificacion": 4}'::jsonb) as r`, [cita]),
    );
    expect(rows[0]!.r.estado).toBe('asistio');
    const [ev] = await eventos('AsistenciaRegistrada');
    expect(ev).toMatchObject({ cita_id: cita, vacante_id: vacanteId, cliente_id: clienteId, asistio: true, event_id: rows[0]!.r.event_id });
    expect(ev!.lead_id).toEqual(expect.any(String));
    const fila = await db.sql.query<Record<string, unknown>>(`select asistio, evaluacion, asistencia_por from citas.citas where id = $1`, [cita]);
    expect(fila.rows[0]).toEqual({ asistio: true, evaluacion: { calificacion: 4 }, asistencia_por: u });
  });

  it('repetir con el mismo valor solo actualiza la evaluación (idempotente, sin nuevo evento); cambiarlo se rechaza', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const cita = await citaConfirmada(vacanteId);
    const u = await crearUsuario(db.sql, 'reclutador', { clienteId, vacantes: [vacanteId] });
    await db.comoUsuario(u, (s) => s.query(`select citas.registrar_asistencia($1, false, null)`, [cita]));
    await db.comoUsuario(u, (s) => s.query(`select citas.registrar_asistencia($1, false, '{"nota":"x"}')`, [cita]));
    expect(await eventos('AsistenciaRegistrada')).toHaveLength(1);
    await expect(db.comoUsuario(u, (s) => s.query(`select citas.registrar_asistencia($1, true, null)`, [cita]))).rejects.toThrow(/TRANSICION_INVALIDA/);
  });

  it('C14 · cancelada → asistió se rechaza', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const cita = await citaConfirmada(vacanteId);
    await db.sql.query(`update citas.citas set estado = 'cancelada' where id = $1`, [cita]);
    const admin = await crearUsuario(db.sql, 'admin');
    await expect(db.comoUsuario(admin, (s) => s.query(`select citas.registrar_asistencia($1, true, null)`, [cita]))).rejects.toThrow(/TRANSICION_INVALIDA/);
  });

  it('rol cliente (solo lectura) y reclutador de otra vacante no pueden operar', async () => {
    const a = await crearVacante(db.sql);
    const b = await crearVacante(db.sql);
    const cita = await citaConfirmada(a.vacanteId);
    const cliente = await crearUsuario(db.sql, 'cliente', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const otro = await crearUsuario(db.sql, 'reclutador', { clienteId: b.clienteId, vacantes: [b.vacanteId] });
    for (const u of [cliente, otro]) {
      await expect(db.comoUsuario(u, (s) => s.query(`select citas.registrar_asistencia($1, true, null)`, [cita]))).rejects.toThrow(/PERMISO_DENEGADO|NO_ENCONTRADA/);
    }
  });

  it('valida la evaluación: objeto y tamaño acotado', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const cita = await citaConfirmada(vacanteId);
    const admin = await crearUsuario(db.sql, 'admin');
    await expect(db.comoUsuario(admin, (s) => s.query(`select citas.registrar_asistencia($1, true, '[1]')`, [cita]))).rejects.toThrow(/EVALUACION_INVALIDA/);
    await expect(
      db.comoUsuario(admin, (s) => s.query(`select citas.registrar_asistencia($1, true, jsonb_build_object('x', repeat('a', 20000)))`, [cita])),
    ).rejects.toThrow(/EVALUACION_INVALIDA/);
  });
});

describe('S1 · RLS de lectura del panel y vista api_ocupacion_diaria', () => {
  it('el reclutador de A no ve citas de B; la vista también respeta RLS', async () => {
    const a = await crearVacante(db.sql);
    const b = await crearVacante(db.sql);
    await retener(db.servicio, { vacante: a.vacanteId, inicio: '2026-11-17T16:00:00Z', estado: 'confirmada' });
    await retener(db.servicio, { vacante: a.vacanteId, inicio: '2026-11-17T16:30:00Z', expira: '2099-01-01T00:00:00Z' });
    await retener(db.servicio, { vacante: b.vacanteId, inicio: '2026-11-17T16:00:00Z', estado: 'confirmada' });
    const u = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const citas = await db.comoUsuario(u, (s) => s.query<{ vacante_id: string }>('select vacante_id from citas.citas'));
    expect(citas.rows.map((r) => r.vacante_id)).toEqual([a.vacanteId, a.vacanteId]);
    const vista = await db.comoUsuario(u, (s) => s.query<Record<string, unknown>>('select vacante_id, retenidas, confirmadas, asistio, no_asistio, cupo from citas.api_ocupacion_diaria'));
    expect(vista.rows).toEqual([{ vacante_id: a.vacanteId, retenidas: 1, confirmadas: 1, asistio: 0, no_asistio: 0, cupo: 10 }]);
  });

  it('la vista toma el cupo de las reglas vigentes de la vacante', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await db.sql.query(`insert into config.vacantes_reglas (vacante_id, version, cliente_id, reglas) values ($1, 1, $2, '{"agenda":{"cupo_diario":5}}')`, [vacanteId, clienteId]);
    await retener(db.servicio, { vacante: vacanteId, inicio: '2026-11-17T16:00:00Z', estado: 'confirmada' });
    const { rows } = await db.servicio.query<{ cupo: number; dia: Date }>('select cupo, dia from citas.api_ocupacion_diaria');
    expect(rows[0]!.cupo).toBe(5);
    expect(rows[0]!.dia.toISOString().slice(0, 10)).toBe('2026-11-17');
  });
});
