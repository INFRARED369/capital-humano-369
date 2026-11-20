/**
 * Reconciliación con Zoho cada 15 min (CIT-09, Z5): el SISTEMA GANA y avisa.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearVacante, guardarReglas } from '@test/db/fixtures';
import { construirEventoMinimo } from '../domain/evento.ts';
import { CalendarioFalso } from '../testing/calendarioFalso.ts';
import { ejecutarWorkerZoho } from '../application/worker.ts';
import { reconciliarZoho } from '../application/reconciliar.ts';
import type { CitasVigentesPort } from '../application/puertos.ts';
import { crearDepsReconciliacionSql, crearDepsZohoSql } from './sqlZoho.ts';

const CAL = 'c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
const CAL2 = 'd2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7';
const PANEL = 'https://panel.369.mx';
let db: TestDb;
let zoho: CalendarioFalso;
let vac: { vacanteId: string; clienteId: string };

const uuid = () => globalThis.crypto.randomUUID();
const enHoras = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const base = () => ({ sql: db.servicio, calendario: zoho, clock: new FixedClock(new Date()), logger: crearLogger({}, () => {}), panelUrl: PANEL });
const worker = () => ejecutarWorkerZoho(crearDepsZohoSql(base()), { lote: 50 });
const reconciliar = (citasVigentes?: CitasVigentesPort) => reconciliarZoho(crearDepsReconciliacionSql({ ...base(), citasVigentes }));

async function confirmar(over: Record<string, unknown> = {}) {
  const p = { cita_id: uuid(), lead_id: uuid(), vacante_id: vac.vacanteId, cliente_id: vac.clienteId, inicio: enHoras(48), fin: enHoras(48.5),
    folio: 'V-7', nombre_pila: 'Ana', reglas_version: 1, event_id: uuid(), ...over };
  await db.sql.query(`select shared.publicar_evento('CitaConfirmada', $1::jsonb, $2)`, [JSON.stringify(p), vac.clienteId]);
  return p;
}
async function alertas(tipo = 'ZOHO_DRIFT') {
  const { rows } = await db.sql.query<{ cita_id: string | null; detalle: Record<string, unknown> }>(`select cita_id, detalle from citas.zoho_alertas where tipo = $1 order by id`, [tipo]);
  return rows;
}
async function registro(citaId: string) {
  const { rows } = await db.sql.query<Record<string, unknown>>('select * from citas.zoho_eventos where cita_id = $1', [citaId]);
  return rows[0]!;
}

beforeEach(async () => {
  db = await crearTestDb();
  zoho = new CalendarioFalso();
  vac = await crearVacante(db.sql);
  await guardarReglas(db.sql, vac.vacanteId, { zoho_calendar_uid: CAL });
}, 60_000);
afterEach(async () => { await db.close(); });

describe('Z5 · drift en Zoho', () => {
  it('evento borrado a mano → se recrea y se registra ZOHO_DRIFT', async () => {
    const p = await confirmar();
    await worker();
    const original = zoho.eventos(CAL)[0]!;
    zoho.borrarAMano(CAL, original.uid);

    const r = await reconciliar();
    expect(r).toMatchObject({ calendarios: 1, drift: 1, errores: 0 });
    const [nuevo] = zoho.eventos(CAL);
    expect(nuevo).toBeDefined();
    expect(nuevo!.titulo).toBe(original.titulo);
    expect((await registro(p.cita_id)).zoho_event_uid).toBe(nuevo!.uid);
    expect(await alertas()).toEqual([{ cita_id: p.cita_id, detalle: expect.objectContaining({ motivo: 'borrado_en_zoho' }) }]);
  });

  it('horario o asistentes editados a mano → se restauran (el sistema gana)', async () => {
    const p = await confirmar();
    await worker();
    const uid = zoho.eventos(CAL)[0]!.uid;
    zoho.editarAMano(CAL, uid, { inicio: enHoras(50), fin: enHoras(51), numAsistentes: 1 });

    await reconciliar();
    const ev = zoho.eventos(CAL)[0]!;
    expect(ev.uid).toBe(uid);
    expect(Date.parse(ev.inicio)).toBe(Date.parse(p.inicio));
    expect(ev.numAsistentes).toBe(0);
    expect(await alertas()).toEqual([{ cita_id: p.cita_id, detalle: expect.objectContaining({ motivo: 'editado_en_zoho', campos: ['inicio', 'fin', 'asistentes'] }) }]);
  });

  it('todo coincide → sin alertas y sin escrituras en Zoho', async () => {
    await confirmar();
    await worker();
    zoho.llamadas.length = 0;
    expect(await reconciliar()).toMatchObject({ drift: 0, acciones: 0 });
    expect(zoho.llamadas).toEqual(['listar']);
    expect(await alertas()).toEqual([]);
  });

  it('evento nuestro huérfano (cita cancelada) → se borra; eventos ajenos no se tocan', async () => {
    const p = await confirmar();
    await worker();
    await db.sql.query(`select shared.publicar_evento('CitaCancelada', $1::jsonb, $2)`,
      [JSON.stringify({ cita_id: p.cita_id, lead_id: p.lead_id, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, motivo: 'x' }), vac.clienteId]);
    zoho.fallarProximas(1, { tipo: 'transitorio', mensaje: '500' }, 'borrar');
    await worker(); // el borrado falla: el evento queda huérfano en Zoho
    const r = construirEventoMinimo({ citaId: uuid(), folio: 'X-1', nombrePila: 'Otro', inicio: enHoras(30), fin: enHoras(31) }, { panelUrl: PANEL, zonaHoraria: 'UTC' });
    if (!r.ok) throw new Error();
    zoho.sembrar(CAL, { ...r.value, descripcion: 'junta interna' }); // ajeno: sin marcador

    // Otra cita vigente en el mismo calendario para que se revise
    await confirmar({ inicio: enHoras(60), fin: enHoras(60.5) });
    await worker();

    await reconciliar();
    const quedan = zoho.eventos(CAL);
    expect(quedan).toHaveLength(2);
    expect(quedan.some((e) => e.uidPropio === `cita-${p.cita_id}`)).toBe(false);
    expect(quedan.some((e) => e.descripcion === 'junta interna')).toBe(true);
    expect(await alertas()).toEqual([expect.objectContaining({ cita_id: p.cita_id, detalle: expect.objectContaining({ motivo: 'huerfano' }) })]);
  });
});

describe('el sistema es la fuente de verdad (CitasVigentesPort)', () => {
  it('la cita ya no está vigente en el sistema (cancelación perdida) → se borra el evento y se avisa', async () => {
    const p = await confirmar();
    await worker();
    await reconciliar({ vigentes: async () => [] });
    expect(zoho.eventos(CAL)).toEqual([]);
    expect(await registro(p.cita_id)).toMatchObject({ vigente: false, estado_sync: 'borrado' });
    expect(await alertas()).toEqual([expect.objectContaining({ cita_id: p.cita_id, detalle: expect.objectContaining({ motivo: 'cita_no_vigente' }) })]);
  });

  it('el horario del sistema difiere del registro → se corrige registro y evento', async () => {
    const p = await confirmar();
    await worker();
    const ini = enHoras(70);
    const fin = enHoras(70.5);
    await reconciliar({ vigentes: async () => [{ citaId: p.cita_id, inicio: ini, fin }] });
    expect(Date.parse(zoho.eventos(CAL)[0]!.inicio)).toBe(Date.parse(ini));
    expect(new Date((await registro(p.cita_id)).inicio as Date).getTime()).toBe(Date.parse(ini));
  });

  it('cita vigente en el sistema sin registro de Zoho → alerta ZOHO_SIN_REGISTRO', async () => {
    const citaId = uuid();
    await confirmar(); // asegura un calendario a revisar
    await worker();
    await reconciliar({
      vigentes: async (r) => [...(await crearDepsReconciliacionSql(base()).citasVigentes.vigentes(r)), { citaId, inicio: enHoras(40), fin: enHoras(41) }],
    });
    expect(await alertas('ZOHO_SIN_REGISTRO')).toEqual([expect.objectContaining({ cita_id: citaId })]);
  });

  it('las citas pasadas no se tocan (la retención las borra a +30 días)', async () => {
    const p = await confirmar({ inicio: enHoras(-3), fin: enHoras(-2.5) });
    await worker();
    zoho.llamadas.length = 0;
    await reconciliar({ vigentes: async () => [] });
    expect(zoho.eventos(CAL)).toHaveLength(1);
    expect(await registro(p.cita_id)).toMatchObject({ vigente: true });
  });
});

describe('recuperación de fallas', () => {
  it('cita en dead letter (Zoho caído) → la reconciliación la publica cuando Zoho vuelve (E2E-07)', async () => {
    const p = await confirmar();
    zoho.fallarProximas(3, { tipo: 'transitorio', mensaje: '500' });
    for (let i = 0; i < 3; i++) {
      await worker();
      await db.sql.query(`update shared.cola set visible_desde = now() where cola = 'zoho-sync'`);
    }
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'error' });
    await reconciliar();
    expect(zoho.eventos(CAL)).toHaveLength(1);
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'sincronizado' });
    expect(await alertas()).toEqual([]);
  });

  it('una cita pendiente (trabajo en cola) no se duplica: la publica el worker', async () => {
    await confirmar();
    await ejecutarWorkerZoho(crearDepsZohoSql(base()), { lote: 0 }); // solo ingesta
    await reconciliar();
    expect(zoho.llamadas).not.toContain('crear');
  });

  it('Z7 resuelto: la vacante ya tiene calendario → se publica la cita sin_calendario', async () => {
    const otra = await crearVacante(db.sql, { clienteId: vac.clienteId });
    const p = await confirmar({ vacante_id: otra.vacanteId });
    await worker();
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'sin_calendario' });
    await guardarReglas(db.sql, otra.vacanteId, { zoho_calendar_uid: CAL2 });
    await reconciliar();
    expect(zoho.eventos(CAL2)).toHaveLength(1);
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'sincronizado', zoho_calendar_uid: CAL2 });
  });

  it('Zoho caído al listar un calendario → alerta ZOHO_RECONCILIACION_ERROR y sigue con los demás', async () => {
    const otra = await crearVacante(db.sql, { clienteId: vac.clienteId });
    await guardarReglas(db.sql, otra.vacanteId, { zoho_calendar_uid: CAL2 });
    await confirmar();
    await confirmar({ vacante_id: otra.vacanteId });
    await worker();
    zoho.borrarAMano(CAL2, zoho.eventos(CAL2)[0]!.uid);
    zoho.fallarProximas(1, { tipo: 'transitorio', status: 503, mensaje: 'HTTP 503' }, 'listar');
    const r = await reconciliar();
    expect(r).toMatchObject({ calendarios: 2, errores: 1 });
    expect(await alertas('ZOHO_RECONCILIACION_ERROR')).toHaveLength(1);
    expect(zoho.eventos(CAL2)).toHaveLength(1);
  });
});
