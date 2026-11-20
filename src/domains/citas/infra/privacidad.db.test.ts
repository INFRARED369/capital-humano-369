/**
 * Citas · privacidad (regla 8 de CONTRATOS, Política de retención: R2, R3, R7 en el schema citas).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearVacante } from '@test/db/fixtures';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000); // la 1.ª vez construye la plantilla con todas las migraciones
afterEach(async () => { await db?.close(); });

const lead = () => globalThis.crypto.randomUUID();

/** Inserta directo (superusuario) una cita en el estado y fechas dados. */
async function cita(vacanteId: string, clienteId: string, o: { lead?: string; estado: string; inicio: string; creado?: string; expira?: string; evaluacion?: unknown }) {
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into citas.citas (cliente_id, vacante_id, lead_id, inicio, fin, dia_local, estado, reglas_version, expira_en, evaluacion, creado_en)
     values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '90 min', ($4::timestamptz at time zone 'America/Mexico_City')::date, $5, 1, $6::timestamptz, $7::jsonb, coalesce($8::timestamptz, now()))
     returning id`,
    [clienteId, vacanteId, o.lead ?? lead(), o.inicio, o.estado, o.expira ?? (o.estado === 'retenida' ? '2026-11-17T02:10:00Z' : null),
      o.evaluacion === undefined ? null : JSON.stringify(o.evaluacion), o.creado ?? null],
  );
  return rows[0]!.id;
}

const fila = async (id: string) =>
  (await db.sql.query<Record<string, unknown>>(`select lead_id, estado, evaluacion, anonimizada_en, vacante_id, inicio from citas.citas where id = $1`, [id])).rows[0]!;

const aplicar = async (ahora: string) =>
  (await db.servicio.query<{ r: Record<string, number> }>(`select citas.retencion_aplicar($1::timestamptz) as r`, [ahora])).rows[0]!.r;

describe('citas.suprimir_lead', () => {
  it('cancela la cita futura, expira la retenida, anonimiza todo y es idempotente', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const l = lead();
    const futura = await cita(vacanteId, clienteId, { lead: l, estado: 'confirmada', inicio: '2099-01-05T16:00:00Z' });
    const otra = await crearVacante(db.sql, { clienteId });
    const retenida = await cita(otra.vacanteId, clienteId, { lead: l, estado: 'retenida', inicio: '2099-01-06T16:00:00Z', expira: '2099-01-01T00:00:00Z' });
    const pasada = await cita(vacanteId, clienteId, { lead: l, estado: 'asistio', inicio: '2026-01-05T16:00:00Z', evaluacion: { nota: 'puntual' } });
    const ajena = await cita(vacanteId, clienteId, { estado: 'confirmada', inicio: '2099-01-05T16:00:00Z' });

    const { rows } = await db.servicio.query<{ r: unknown }>(`select citas.suprimir_lead($1) as r`, [l]);
    expect(rows[0]!.r).toMatchObject({ canceladas: 1, expiradas: 1, anonimizadas: 3 });
    expect(await fila(futura)).toMatchObject({ lead_id: null, estado: 'cancelada', evaluacion: null });
    expect(await fila(retenida)).toMatchObject({ lead_id: null, estado: 'expirada' });
    expect(await fila(pasada)).toMatchObject({ lead_id: null, estado: 'asistio', evaluacion: null, vacante_id: vacanteId });
    expect((await fila(ajena)).lead_id).not.toBeNull();

    const ev = await db.sql.query<{ tipo: string; payload: Record<string, unknown> }>(`select tipo, payload from shared.outbox order by id`);
    expect(ev.rows.map((e) => e.tipo)).toEqual(['CitaCancelada', 'CitaExpirada']);
    expect(ev.rows[0]!.payload).toMatchObject({ cita_id: futura, lead_id: l, motivo: 'supresion' });

    const segunda = await db.servicio.query<{ r: unknown }>(`select citas.suprimir_lead($1) as r`, [l]);
    expect(segunda.rows[0]!.r).toMatchObject({ canceladas: 0, expiradas: 0, anonimizadas: 0 });
  });
});

describe('citas.retencion_aplicar', () => {
  const AHORA = '2026-11-17T12:00:00Z';

  it('R2 · retenciones vencidas se liberan y las de leads sin verificar de > 48 h se anonimizan', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const vencida = await cita(vacanteId, clienteId, { estado: 'retenida', inicio: '2026-11-18T16:00:00Z', expira: '2026-11-17T11:00:00Z', creado: '2026-11-17T10:50:00Z' });
    const vieja = await cita(vacanteId, clienteId, { estado: 'expirada', inicio: '2026-11-16T16:00:00Z', creado: '2026-11-15T11:00:00Z' });
    const reciente = await cita(vacanteId, clienteId, { estado: 'expirada', inicio: '2026-11-18T16:00:00Z', creado: '2026-11-16T13:00:00Z' });
    const r = await aplicar(AHORA);
    expect(r).toMatchObject({ retenciones_expiradas: 1, sin_verificar_48h: 1 });
    expect(await fila(vencida)).toMatchObject({ estado: 'expirada' });
    expect((await fila(vieja)).lead_id).toBeNull();
    expect((await fila(reciente)).lead_id).not.toBeNull();
  });

  it('R3 · cita no asistida o cancelada de hace 61 días → anonimizada; de hace 59 no', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const noAsistio61 = await cita(vacanteId, clienteId, { estado: 'no_asistio', inicio: '2026-09-17T16:00:00Z' });
    const cancelada61 = await cita(vacanteId, clienteId, { estado: 'cancelada', inicio: '2026-09-17T16:00:00Z' });
    const noAsistio59 = await cita(vacanteId, clienteId, { estado: 'no_asistio', inicio: '2026-09-19T16:00:00Z' });
    const asistio61 = await cita(vacanteId, clienteId, { estado: 'asistio', inicio: '2026-09-17T16:00:00Z' });
    expect(await aplicar(AHORA)).toMatchObject({ cancelada_no_asistio_60d: 2, asistio_120d: 0 });
    expect((await fila(noAsistio61)).lead_id).toBeNull();
    expect((await fila(cancelada61)).lead_id).toBeNull();
    expect((await fila(noAsistio59)).lead_id).not.toBeNull();
    expect((await fila(asistio61)).lead_id).not.toBeNull();
  });

  it('asistió: se anonimiza a los 90 + 30 días; la función es idempotente', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const asistio = await cita(vacanteId, clienteId, { estado: 'asistio', inicio: '2026-07-10T16:00:00Z', evaluacion: { nota: 'x' } });
    expect(await aplicar(AHORA)).toMatchObject({ asistio_120d: 1 });
    expect(await aplicar(AHORA)).toMatchObject({ retenciones_expiradas: 0, sin_verificar_48h: 0, cancelada_no_asistio_60d: 0, asistio_120d: 0 });
    expect(await fila(asistio)).toMatchObject({ lead_id: null, evaluacion: null, estado: 'asistio' });
  });

  it('R7 · una cita anonimizada conserva solo vacante, fechas y estado (restricción de esquema)', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const id = await cita(vacanteId, clienteId, { estado: 'asistio', inicio: '2026-01-05T16:00:00Z' });
    await expect(db.sql.query(`update citas.citas set anonimizada_en = now() where id = $1`, [id])).rejects.toThrow(/check/i);
    await aplicar(AHORA);
    const f = await fila(id);
    expect(f).toMatchObject({ lead_id: null, evaluacion: null, estado: 'asistio', vacante_id: vacanteId });
    expect(f.anonimizada_en).not.toBeNull();
  });
});
