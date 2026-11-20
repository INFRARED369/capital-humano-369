/**
 * Citas · casos de uso contra PGlite a través de la API pública (index.ts).
 * C1/C9 de punta a punta, C12, C13, CIT-06, CIT-07, CIT-11 y contrato de CitaConfirmada.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearVacante, guardarReglas } from '@test/db/fixtures';
import {
  cancelarCita,
  confirmarCita,
  crearAgendaPort,
  extenderRetencion,
  liberarRetencion,
  RETENCION_MAX_TTLS,
  obtenerSlots,
  reprogramarCita,
  retenerSlot,
} from '../index.ts';
import { limpiarCacheReglas } from './reglasVigentes.ts';

let db: TestDb;
let clock: FixedClock;
beforeEach(async () => {
  db = await crearTestDb();
  clock = new FixedClock(new Date('2026-11-17T02:00:00Z')); // lunes 16-nov 20:00 CDMX
  limpiarCacheReglas();
}, 120_000);
afterEach(async () => { await db?.close(); });

const MARTES_10 = '2026-11-17T16:00:00.000Z';
const lead = () => globalThis.crypto.randomUUID();
const eventos = async (tipo: string) =>
  (await db.sql.query<{ payload: Record<string, unknown> }>(`select payload from shared.outbox where tipo = $1 order by id`, [tipo])).rows.map((r) => r.payload);
const estado = async (id: string) => (await db.sql.query<{ estado: string }>(`select estado from citas.citas where id = $1`, [id])).rows[0]?.estado;

async function retenida(vacanteId: string, inicio = MARTES_10, leadId = lead()) {
  const r = await db.servicio.transaction((tx) => retenerSlot(tx, { vacanteId, leadId, inicio }, clock));
  if (!r.ok) throw new Error(r.error);
  return { ...r.value, leadId };
}

describe('obtenerSlots', () => {
  it('C1 · sin reglas guardadas usa la plantilla (versión 0) y busca por id o slug', async () => {
    const { vacanteId } = await crearVacante(db.sql, { slug: 'agente-smart' });
    for (const ref of [vacanteId, 'agente-smart']) {
      const r = await obtenerSlots({ sql: db.servicio, clock }, ref);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.reglasVersion).toBe(0);
      expect(r.value.zonaHoraria).toBe('America/Mexico_City');
      expect(r.value.vacanteId).toBe(vacanteId);
      expect(r.value.slots.filter((s) => s.fecha === '2026-11-17')).toHaveLength(13);
    }
  });

  it('vacante inexistente, inactiva o referencia inválida → VACANTE_NO_ENCONTRADA', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    await db.sql.query('update shared.vacantes set activa = false where id = $1', [vacanteId]);
    for (const ref of [vacanteId, globalThis.crypto.randomUUID(), 'no-existe', "x' or 1=1 --"]) {
      expect(await obtenerSlots({ sql: db.servicio, clock }, ref)).toEqual({ ok: false, error: 'VACANTE_NO_ENCONTRADA' });
    }
  });

  it('vacante en modo whatsapp (F7.4) no ofrece slots del sistema', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    await db.sql.query(`update shared.vacantes set agenda_modo = 'whatsapp' where id = $1`, [vacanteId]);
    const r = await obtenerSlots({ sql: db.servicio, clock }, vacanteId);
    expect(r.ok && r.value.slots).toEqual([]);
  });

  it('descuenta retenidas vigentes y confirmadas', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    await retenida(vacanteId);
    const r = await obtenerSlots({ sql: db.servicio, clock }, vacanteId);
    expect(r.ok && r.value.slots.some((s) => s.inicio === MARTES_10)).toBe(false);
  });

  it('C12 · retención de hace 11 min sin OTP: el slot vuelve a estar libre y la cita queda expirada', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const { citaId } = await retenida(vacanteId);
    clock.advanceMinutes(11);
    const r = await obtenerSlots({ sql: db.servicio, clock }, vacanteId);
    expect(r.ok && r.value.slots.some((s) => s.inicio === MARTES_10)).toBe(true);
    expect(await estado(citaId)).toBe('expirada');
    expect((await eventos('CitaExpirada')).map((e) => e.cita_id)).toEqual([citaId]);
  });

  it('reglas guardadas inválidas → error explícito (no se adivinan reglas)', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    await guardarReglas(db.sql, vacanteId, { agenda: { cupo_diario: 'muchos' } });
    await expect(obtenerSlots({ sql: db.servicio, clock }, vacanteId)).rejects.toThrow(/REGLAS_INVALIDAS/);
  });
});

describe('retenerSlot (CIT-05, CIT-06)', () => {
  it('retiene con TTL de las reglas y guarda la versión', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const v = await guardarReglas(db.sql, vacanteId, { agenda: { ttl_retencion_min: 15 }, mensajes: {} });
    const r = await retenida(vacanteId);
    expect(r.expiraEn).toBe('2026-11-17T02:15:00.000Z');
    expect(r.reglasVersion).toBe(v);
    const { rows } = await db.sql.query<{ reglas_version: number }>('select reglas_version from citas.citas where id = $1', [r.citaId]);
    expect(rows[0]!.reglas_version).toBe(v);
  });

  it('SLOT_INVALIDO, SLOT_LLENO, CUPO_DIARIO y VACANTE_NO_ENCONTRADA', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    await guardarReglas(db.sql, vacanteId, { agenda: { cupo_diario: 2 } });
    const ret = (inicio: string, v = vacanteId) => db.servicio.transaction((tx) => retenerSlot(tx, { vacanteId: v, leadId: lead(), inicio }, clock));
    expect(await ret('2026-11-17T16:15:00Z')).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
    expect((await ret(MARTES_10)).ok).toBe(true);
    expect(await ret(MARTES_10)).toEqual({ ok: false, error: 'SLOT_LLENO' });
    expect((await ret('2026-11-17T16:30:00Z')).ok).toBe(true);
    expect(await ret('2026-11-17T17:00:00Z')).toEqual({ ok: false, error: 'CUPO_DIARIO' });
    expect(await ret(MARTES_10, globalThis.crypto.randomUUID())).toEqual({ ok: false, error: 'VACANTE_NO_ENCONTRADA' });
    expect(await ret(MARTES_10, 'no-uuid')).toEqual({ ok: false, error: 'VACANTE_NO_ENCONTRADA' });
  });

  it('un lead con cita confirmada en la vacante no retiene otra (SLOT_INVALIDO)', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r = await retenida(vacanteId);
    await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: r.citaId, folio: 'A1', nombrePila: 'Ana', eventId: lead() }, clock));
    const otra = await db.servicio.transaction((tx) => retenerSlot(tx, { vacanteId, leadId: r.leadId, inicio: '2026-11-17T17:00:00Z' }, clock));
    expect(otra).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
  });
});

describe('confirmarCita (O1 → CitaConfirmada)', () => {
  it('confirma y publica CitaConfirmada con el payload de src/shared/eventos.ts en la misma tx', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const r = await retenida(vacanteId);
    const eventId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    clock.advanceMinutes(5);
    const c = await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: r.citaId, folio: 'F-123', nombrePila: '  Ana ', eventId }, clock));
    expect(c).toEqual({ ok: true, value: { citaId: r.citaId, inicio: MARTES_10, fin: '2026-11-17T17:30:00.000Z' } });
    expect(await estado(r.citaId)).toBe('confirmada');
    expect(await eventos('CitaConfirmada')).toEqual([
      { cita_id: r.citaId, lead_id: r.leadId, vacante_id: vacanteId, cliente_id: clienteId, inicio: MARTES_10, fin: '2026-11-17T17:30:00.000Z',
        folio: 'F-123', nombre_pila: 'Ana', reglas_version: 0, event_id: eventId },
    ]);
    // idempotente: reintentar no publica de nuevo
    const otra = await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: r.citaId, folio: 'F-123', nombrePila: 'Ana', eventId }, clock));
    expect(otra.ok).toBe(true);
    expect(await eventos('CitaConfirmada')).toHaveLength(1);
  });

  it('retención vencida → EXPIRADA (y la cita queda expirada)', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r = await retenida(vacanteId);
    clock.advanceMinutes(10);
    const c = await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: r.citaId, folio: 'F', nombrePila: 'Ana', eventId: lead() }, clock));
    expect(c).toEqual({ ok: false, error: 'EXPIRADA' });
    expect(await estado(r.citaId)).toBe('expirada');
  });

  it('NO_ENCONTRADA y TRANSICION_INVALIDA', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const conf = (citaId: string) => db.servicio.transaction((tx) => confirmarCita(tx, { citaId, folio: 'F', nombrePila: 'Ana', eventId: lead() }, clock));
    expect(await conf(lead())).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    expect(await conf('x')).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    const r = await retenida(vacanteId);
    await db.servicio.transaction((tx) => liberarRetencion(tx, { citaId: r.citaId, motivo: 'otp_fallido' }));
    expect(await conf(r.citaId)).toEqual({ ok: false, error: 'TRANSICION_INVALIDA' });
  });
});

describe('extenderRetencion (reenvío del OTP)', () => {
  const extender = (citaId: string) => db.servicio.transaction((tx) => extenderRetencion(tx, { citaId }, clock));
  const expira = async (id: string) => new Date((await db.sql.query<{ e: string }>('select expira_en as e from citas.citas where id = $1', [id])).rows[0]!.e).toISOString();

  it('extiende el TTL desde ahora, sin pasar de RETENCION_MAX_TTLS × TTL desde la retención; nunca acorta', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const t0 = clock.now().getTime();
    const r = await retenida(vacanteId);
    expect(RETENCION_MAX_TTLS).toBe(3);
    clock.advanceMinutes(8);
    expect(await extender(r.citaId)).toEqual({ ok: true, value: { citaId: r.citaId, expiraEn: new Date(t0 + 18 * 60_000).toISOString() } });
    expect(await expira(r.citaId)).toBe(new Date(t0 + 18 * 60_000).toISOString());
    // el slot sigue ocupado después de los 10 min originales
    clock.advanceMinutes(7);
    const slots = await obtenerSlots({ sql: db.servicio, clock }, vacanteId);
    expect(slots.ok && (slots.value.slots.find((x) => x.inicio === MARTES_10)?.disponibles ?? 0)).toBe(0);
    expect(await extender(r.citaId)).toEqual({ ok: true, value: { citaId: r.citaId, expiraEn: new Date(t0 + 25 * 60_000).toISOString() } });
    clock.advanceMinutes(7); // t0 + 22 → ahora + 10 = t0 + 32, tope t0 + 30
    expect(await extender(r.citaId)).toEqual({ ok: true, value: { citaId: r.citaId, expiraEn: new Date(t0 + 30 * 60_000).toISOString() } });
    clock.advanceMinutes(1);
    expect((await extender(r.citaId)).ok).toBe(true);
    expect(await expira(r.citaId)).toBe(new Date(t0 + 30 * 60_000).toISOString());
    expect(await eventos('CitaRetenida')).toHaveLength(1);
  });

  it('vencida → EXPIRADA (queda expirada y libera el slot); confirmada → TRANSICION_INVALIDA; inexistente → NO_ENCONTRADA', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r = await retenida(vacanteId);
    clock.advanceMinutes(11);
    expect(await extender(r.citaId)).toEqual({ ok: false, error: 'EXPIRADA' });
    expect(await estado(r.citaId)).toBe('expirada');
    expect(await eventos('CitaExpirada')).toHaveLength(1);
    const c = await retenida(vacanteId);
    await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: c.citaId, folio: '369-ABCDEF', nombrePila: 'Ana', eventId: lead() }, clock));
    expect(await extender(c.citaId)).toEqual({ ok: false, error: 'TRANSICION_INVALIDA' });
    expect(await extender(lead())).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    expect(await extender('no-uuid')).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
  });

  it('crearAgendaPort expone extender (contrato con captación)', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r = await retenida(vacanteId);
    clock.advanceMinutes(5);
    const port = crearAgendaPort(clock);
    expect((await db.servicio.transaction((tx) => port.extender(tx, { citaId: r.citaId }))).ok).toBe(true);
  });
});

describe('liberarRetencion (O2)', () => {
  it('libera, publica CitaExpirada, guarda el motivo saneado y es idempotente', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r = await retenida(vacanteId);
    await db.servicio.transaction((tx) => liberarRetencion(tx, { citaId: r.citaId, motivo: 'OTP fallido 5 veces!' }));
    await db.servicio.transaction((tx) => liberarRetencion(tx, { citaId: r.citaId, motivo: 'otp_fallido' }));
    await db.servicio.transaction((tx) => liberarRetencion(tx, { citaId: lead(), motivo: 'otp_fallido' }));
    const { rows } = await db.sql.query<{ estado: string; motivo: string }>('select estado, motivo from citas.citas where id = $1', [r.citaId]);
    expect(rows[0]).toEqual({ estado: 'expirada', motivo: 'otro' });
    expect(await eventos('CitaExpirada')).toHaveLength(1);
    const slots = await obtenerSlots({ sql: db.servicio, clock }, vacanteId);
    expect(slots.ok && slots.value.slots.some((s) => s.inicio === MARTES_10)).toBe(true);
  });
});

describe('C13 · las reglas cambian de v3 a v4', () => {
  it('las citas confirmadas con v3 se respetan; los slots nuevos usan v4', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    for (let i = 0; i < 3; i++) await guardarReglas(db.sql, vacanteId, { agenda: {} });
    const tarde = '2026-11-17T22:00:00.000Z'; // 16:00 local
    const r = await retenida(vacanteId, tarde);
    expect(r.reglasVersion).toBe(3);
    await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: r.citaId, folio: 'F', nombrePila: 'Ana', eventId: lead() }, clock));

    // v4 quita la tarde
    await guardarReglas(db.sql, vacanteId, { agenda: { ventanas_inicio: [{ desde: '09:30', hasta: '13:00' }] } });
    const s = await obtenerSlots({ sql: db.servicio, clock }, vacanteId);
    expect(s.ok && s.value.reglasVersion).toBe(4);
    expect(s.ok && s.value.slots.filter((x) => x.fecha === '2026-11-17').map((x) => x.horaLocal)).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00']);
    const { rows } = await db.sql.query<{ estado: string; reglas_version: number }>('select estado, reglas_version from citas.citas where id = $1', [r.citaId]);
    expect(rows[0]).toEqual({ estado: 'confirmada', reglas_version: 3 });
    // un nuevo intento en la tarde ya no es válido con v4
    const nuevo = await db.servicio.transaction((tx) => retenerSlot(tx, { vacanteId, leadId: lead(), inicio: '2026-11-17T22:30:00Z' }, clock));
    expect(nuevo).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
  });
});

describe('cancelar y reprogramar (CIT-07, CIT-11)', () => {
  async function confirmada(vacanteId: string, inicio = MARTES_10) {
    const r = await retenida(vacanteId, inicio);
    await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: r.citaId, folio: 'F-9', nombrePila: 'Ana', eventId: lead() }, clock));
    return r;
  }
  const contactos = { datosCita: async () => ({ folio: 'F-9', nombrePila: 'Ana' }) };

  it('cancelar una confirmada publica CitaCancelada y libera el slot', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const r = await confirmada(vacanteId);
    const c = await db.servicio.transaction((tx) => cancelarCita(tx, { citaId: r.citaId, motivo: 'candidato' }, clock));
    expect(c).toEqual({ ok: true, value: { citaId: r.citaId } });
    expect(await eventos('CitaCancelada')).toEqual([{ cita_id: r.citaId, lead_id: r.leadId, vacante_id: vacanteId, cliente_id: clienteId, motivo: 'candidato' }]);
    const again = await db.servicio.transaction((tx) => cancelarCita(tx, { citaId: r.citaId, motivo: 'candidato' }, clock));
    expect(again).toEqual({ ok: false, error: 'TRANSICION_INVALIDA' });
    const s = await obtenerSlots({ sql: db.servicio, clock }, vacanteId);
    expect(s.ok && s.value.slots.some((x) => x.inicio === MARTES_10)).toBe(true);
  });

  it('no se cancela una cita que ya empezó (FUERA_DE_TIEMPO) ni una inexistente', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r = await confirmada(vacanteId);
    clock.set(MARTES_10);
    expect(await db.servicio.transaction((tx) => cancelarCita(tx, { citaId: r.citaId, motivo: 'candidato' }, clock))).toEqual({ ok: false, error: 'FUERA_DE_TIEMPO' });
    expect(await db.servicio.transaction((tx) => cancelarCita(tx, { citaId: lead(), motivo: 'x' }, clock))).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
  });

  it('reprogramar crea una cita confirmada nueva, marca la anterior y publica CitaReprogramada', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const r = await confirmada(vacanteId);
    const nuevo = '2026-11-18T16:00:00.000Z';
    const rep = await reprogramarCita(db.servicio, { citaId: r.citaId, nuevoInicio: nuevo }, { contactos, clock });
    expect(rep.ok).toBe(true);
    if (!rep.ok) return;
    expect(rep.value).toMatchObject({ inicio: nuevo, fin: '2026-11-18T17:30:00.000Z' });
    expect(await estado(r.citaId)).toBe('reprogramada');
    expect(await estado(rep.value.citaId)).toBe('confirmada');
    expect(await eventos('CitaReprogramada')).toEqual([{
      cita_id: rep.value.citaId, cita_anterior_id: r.citaId, lead_id: r.leadId, vacante_id: vacanteId, cliente_id: clienteId,
      inicio: nuevo, fin: '2026-11-18T17:30:00.000Z', folio: 'F-9', nombre_pila: 'Ana',
    }]);
    const { rows } = await db.sql.query<{ cita_anterior_id: string }>('select cita_anterior_id from citas.citas where id = $1', [rep.value.citaId]);
    expect(rows[0]!.cita_anterior_id).toBe(r.citaId);
  });

  it('reprogramar a un slot lleno o inválido revierte todo (la original sigue confirmada)', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const r = await confirmada(vacanteId);
    await confirmada(vacanteId, '2026-11-18T16:00:00.000Z');
    expect(await reprogramarCita(db.servicio, { citaId: r.citaId, nuevoInicio: '2026-11-18T16:00:00Z' }, { contactos, clock })).toEqual({ ok: false, error: 'SLOT_LLENO' });
    expect(await reprogramarCita(db.servicio, { citaId: r.citaId, nuevoInicio: '2026-11-18T16:10:00Z' }, { contactos, clock })).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
    expect(await reprogramarCita(db.servicio, { citaId: r.citaId, nuevoInicio: MARTES_10 }, { contactos, clock })).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
    expect(await estado(r.citaId)).toBe('confirmada');
    expect(await eventos('CitaReprogramada')).toEqual([]);
    const sinContacto = { datosCita: async () => null };
    expect(await reprogramarCita(db.servicio, { citaId: r.citaId, nuevoInicio: '2026-11-19T16:00:00Z' }, { contactos: sinContacto, clock })).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    expect(await estado(r.citaId)).toBe('confirmada');
  });
});

describe('crearAgendaPort (AgendaPort de captación)', () => {
  it('retener → confirmar → liberar con la firma del puerto', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    const agenda = crearAgendaPort(clock);
    const leadId = lead();
    const r = await db.servicio.transaction((tx) => agenda.retener(tx, { vacanteId, leadId, inicio: MARTES_10 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = await db.servicio.transaction((tx) => agenda.confirmar(tx, { citaId: r.value.citaId, folio: 'F', nombrePila: 'Ana', eventId: lead() }));
    expect(c.ok).toBe(true);
    await db.servicio.transaction((tx) => agenda.liberar(tx, { citaId: r.value.citaId, motivo: 'otp_fallido' }));
    expect(await estado(r.value.citaId)).toBe('confirmada'); // liberar no toca confirmadas
  });
});
