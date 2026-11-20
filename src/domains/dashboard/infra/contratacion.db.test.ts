/**
 * Contratación y entrega de expediente desde el panel → LeadContratado (orquestador, ola 2).
 * dashboard.registrar_contratacion(p_cita, p_entregado): valida puede_operar_vacante, lee la cita por la API
 * pública citas.api_citas_panel y publica LeadContratado en el outbox (privacidad y tracking lo consumen).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import type { PayloadDe } from '@shared/eventos.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante } from '@test/db/fixtures';
import { confirmarCita, retenerSlot } from '@domains/citas/index.ts';

let db: TestDb;
let A: { vacanteId: string; clienteId: string };
let B: { vacanteId: string; clienteId: string };
let reclA: string;
let reclB: string;
let clienteA: string;
let citaA: string;
let leadA: string;
const clock = new FixedClock(new Date('2026-11-17T02:00:00Z'));

async function citaConfirmada(vacanteId: string, inicio = '2026-11-17T16:00:00.000Z') {
  const leadId = globalThis.crypto.randomUUID();
  const citaId = await db.servicio.transaction(async (tx) => {
    const r = await retenerSlot(tx, { vacanteId, leadId, inicio }, clock);
    if (r.ok === false) throw new Error(r.error);
    const c = await confirmarCita(tx, { citaId: r.value.citaId, folio: '369-ABCDEF', nombrePila: 'Ana', eventId: globalThis.crypto.randomUUID() }, clock);
    if (c.ok === false) throw new Error(c.error);
    return r.value.citaId;
  });
  return { citaId, leadId };
}

const registrar = (u: string, cita: string, entregado = false) =>
  db.comoUsuario(u, (s) => s.query<{ r: { estado: string; event_id: string; contratado_en: string; entregado_en: string | null } }>('select dashboard.registrar_contratacion($1, $2) as r', [cita, entregado]));
const eventos = async () =>
  (await db.sql.query<{ payload: PayloadDe<'LeadContratado'>; cliente_id: string }>(`select payload, cliente_id from shared.outbox where tipo = 'LeadContratado' order by id`)).rows;

beforeEach(async () => {
  db = await crearTestDb();
  A = await crearVacante(db.sql, { slug: 'ctr-a' });
  B = await crearVacante(db.sql, { slug: 'ctr-b' });
  reclA = await crearUsuario(db.sql, 'reclutador', { clienteId: A.clienteId, vacantes: [A.vacanteId] });
  reclB = await crearUsuario(db.sql, 'reclutador', { clienteId: B.clienteId, vacantes: [B.vacanteId] });
  clienteA = await crearUsuario(db.sql, 'cliente', { clienteId: A.clienteId, vacantes: [A.vacanteId] });
  ({ citaId: citaA, leadId: leadA } = await citaConfirmada(A.vacanteId));
  await db.comoUsuario(reclA, (s) => s.query('select citas.registrar_asistencia($1, true, null)', [citaA]));
}, 120_000);
afterEach(async () => { await db?.close(); });

describe('dashboard.registrar_contratacion', () => {
  it('contratado → LeadContratado con entregado_en null; luego entregado → LeadContratado con entregado_en', async () => {
    const r1 = await registrar(reclA, citaA);
    expect(r1.rows[0]!.r).toMatchObject({ estado: 'contratado', entregado_en: null });
    const r2 = await registrar(reclA, citaA, true);
    expect(r2.rows[0]!.r.estado).toBe('entregado');
    const ev = await eventos();
    expect(ev).toHaveLength(2);
    expect(ev[0]!.payload).toEqual({ lead_id: leadA, vacante_id: A.vacanteId, cliente_id: A.clienteId, cita_id: citaA, entregado_en: null, event_id: r1.rows[0]!.r.event_id });
    expect(ev[1]!.payload).toMatchObject({ lead_id: leadA, cita_id: citaA, event_id: r2.rows[0]!.r.event_id });
    expect(ev[1]!.payload.entregado_en).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ev[0]!.payload.event_id).not.toBe(ev[1]!.payload.event_id);
    expect(ev.every((e) => e.cliente_id === A.clienteId)).toBe(true);
  });

  it('idempotente: repetir cada paso no publica eventos nuevos y devuelve el mismo event_id', async () => {
    const a = await registrar(reclA, citaA);
    const b = await registrar(reclA, citaA);
    expect(b.rows[0]!.r.event_id).toBe(a.rows[0]!.r.event_id);
    await registrar(reclA, citaA, true);
    await registrar(reclA, citaA, true);
    expect(await eventos()).toHaveLength(2);
  });

  it('marcar entregado sin contratado registra ambos pasos en uno (contratado + entregado)', async () => {
    const r = await registrar(reclA, citaA, true);
    expect(r.rows[0]!.r.estado).toBe('entregado');
    const ev = await eventos();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload.entregado_en).not.toBeNull();
  });

  it('solo citas con asistencia: confirmada sin asistir → TRANSICION_INVALIDA', async () => {
    const { citaId } = await citaConfirmada(A.vacanteId, '2026-11-17T16:30:00.000Z');
    await expect(registrar(reclA, citaId)).rejects.toThrow(/TRANSICION_INVALIDA/);
  });

  it('S1/S3: reclutador de otra vacante y rol cliente → PERMISO_DENEGADO; anon sin permiso; cita inexistente → NO_ENCONTRADA', async () => {
    await expect(registrar(reclB, citaA)).rejects.toThrow(/PERMISO_DENEGADO/);
    await expect(registrar(clienteA, citaA)).rejects.toThrow(/PERMISO_DENEGADO/);
    await expect(db.como('anon', null, (s) => s.query('select dashboard.registrar_contratacion($1, false)', [citaA]))).rejects.toThrow(/permission denied/);
    await expect(registrar(reclA, globalThis.crypto.randomUUID())).rejects.toThrow(/NO_ENCONTRADA/);
    expect(await eventos()).toHaveLength(0);
  });

  it('el panel lee el estado (sin lead_id) según RLS; el cliente lo ve en solo lectura', async () => {
    await registrar(reclA, citaA, true);
    const fila = await db.comoUsuario(clienteA, (s) => s.query<{ cita_id: string; entregado_en: string | null }>('select cita_id, contratado_en, entregado_en from dashboard.contrataciones'));
    expect(fila.rows).toHaveLength(1);
    expect(fila.rows[0]!.entregado_en).not.toBeNull();
    expect((await db.comoUsuario(reclB, (s) => s.query('select cita_id from dashboard.contrataciones'))).rows).toEqual([]);
    await expect(db.comoUsuario(reclA, (s) => s.query('select lead_id from dashboard.contrataciones'))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(reclA, (s) => s.query(`update dashboard.contrataciones set entregado_en = null`))).rejects.toThrow(/permission denied/);
  });
});

describe('privacidad del schema dashboard (regla 8 de CONTRATOS)', () => {
  it('suprimir_lead desliga el lead (idempotente); retencion_aplicar anonimiza 30 días tras la entrega o 60 tras contratar', async () => {
    await registrar(reclA, citaA, true);
    const { citaId: c2, leadId: l2 } = await citaConfirmada(A.vacanteId, '2026-11-17T16:30:00.000Z');
    await db.comoUsuario(reclA, (s) => s.query('select citas.registrar_asistencia($1, true, null)', [c2]));
    await registrar(reclA, c2);

    expect((await db.servicio.query<{ r: { contrataciones: number } }>('select dashboard.suprimir_lead($1) as r', [l2])).rows[0]!.r.contrataciones).toBe(1);
    expect((await db.servicio.query<{ r: { contrataciones: number } }>('select dashboard.suprimir_lead($1) as r', [l2])).rows[0]!.r.contrataciones).toBe(0);

    const ahora = new Date(Date.now() + 31 * 86_400_000).toISOString();
    const r = await db.servicio.query<{ r: Record<string, number> }>('select dashboard.retencion_aplicar($1::timestamptz) as r', [ahora]);
    expect(r.rows[0]!.r.contratacion_entregada_30d).toBe(1);
    const quedan = await db.sql.query<{ n: number }>('select count(*)::int as n from dashboard.contrataciones where lead_id is not null');
    expect(quedan.rows[0]!.n).toBe(0);
    await expect(db.comoUsuario(reclA, (s) => s.query('select dashboard.suprimir_lead($1)', [leadA]))).rejects.toThrow(/permission denied/);
  });
});
