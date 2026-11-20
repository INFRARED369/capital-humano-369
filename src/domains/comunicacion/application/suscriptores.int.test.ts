import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import type { PayloadDe } from '@shared/eventos.ts';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearVacante, guardarReglas } from '../../../../test/db/fixtures.ts';
import { crearReglasVacanteSql } from '../infra/reglas-sql.ts';
import { procesarEventosCitas, CONSUMIDOR, type DepsSuscriptores } from './suscriptores.ts';

const LEAD = '0190d3a0-0000-7000-8000-0000000000c1';
const CITA = '0190d3a0-0000-7000-8000-0000000000c2';
const CITA_NUEVA = '0190d3a0-0000-7000-8000-0000000000c3';

let db: TestDb;
let deps: DepsSuscriptores;
let vacanteId: string;
let clienteId: string;
let links: Array<{ citaId: string; accion: string; expiraEn: string }>;

beforeEach(async () => {
  db = await crearTestDb();
  ({ vacanteId, clienteId } = await crearVacante(db.sql));
  links = [];
  deps = {
    sql: db.servicio,
    clock: new FixedClock(new Date('2026-11-16T17:00:00Z')),
    reglasEn: (tx) => crearReglasVacanteSql(tx),
    links: { firmar: async (i) => (links.push(i), `https://369.mx/cita/${i.accion}?t=tok-${i.citaId.slice(-2)}`) },
    logger: crearLogger({}, () => {}),
  };
}, 120_000);
afterEach(async () => {
  await db?.close();
});

const publicar = (tipo: string, payload: object) =>
  db.sql.query(`select shared.publicar_evento($1, $2::jsonb, $3::uuid, 'corr-123')`, [tipo, JSON.stringify(payload), clienteId]);

const confirmada = (over: Partial<PayloadDe<'CitaConfirmada'>> = {}): PayloadDe<'CitaConfirmada'> => ({
  cita_id: CITA,
  lead_id: LEAD,
  vacante_id: vacanteId,
  cliente_id: clienteId,
  inicio: '2026-11-19T17:00:00.000Z', // jueves 11:00 CDMX
  fin: '2026-11-19T17:30:00.000Z',
  folio: 'AS-0001',
  nombre_pila: 'Ana',
  reglas_version: 1,
  event_id: 'ev-1',
  ...over,
});

const mensajes = async () =>
  (
    await db.sql.query<{ tipo: string; estado: string; programado_para: string; variables: Record<string, string> | null; cita_id: string; llave: string; correlation_id: string; canal: string }>(
      `select tipo, estado, programado_para, variables, cita_id, llave, correlation_id, canal from comunicacion.mensajes order by prioridad, programado_para`,
    )
  ).rows;

describe('CitaConfirmada → confirmación + recordatorios 24 h y 2 h', () => {
  it('encola la confirmación inmediata y programa los recordatorios con links firmados', async () => {
    await publicar('CitaConfirmada', confirmada());
    expect(await procesarEventosCitas(deps)).toMatchObject({ eventos: 1, encolados: 3 });
    const ms = await mensajes();
    expect(ms.map((m) => [m.tipo, new Date(m.programado_para).toISOString()])).toEqual([
      ['confirmacion', expect.any(String)],
      ['recordatorio_2h', '2026-11-19T15:00:00.000Z'],
      ['recordatorio_24h', '2026-11-18T17:00:00.000Z'],
    ]);
    expect(ms[0]!.variables).toEqual({ fecha: 'jueves, 19 de noviembre', hora: '11:00', link_cancelar: 'https://369.mx/cita/cancelar?t=tok-c2', link_reprogramar: 'https://369.mx/cita/reprogramar?t=tok-c2' });
    expect(ms.every((m) => m.cita_id === CITA && m.correlation_id === 'corr-123' && m.canal === 'email')).toBe(true);
    expect(JSON.stringify(ms)).not.toContain('Ana');
    expect(links[0]).toEqual({ citaId: CITA, accion: 'cancelar', expiraEn: '2026-11-19T17:00:00.000Z' });
    const cola = await db.sql.query(`select 1 from shared.cola where cola = 'comunicacion'`);
    expect(cola.rows).toHaveLength(3);
  });

  it('es idempotente: reprocesar el mismo evento no duplica y el cursor avanza', async () => {
    await publicar('CitaConfirmada', confirmada());
    await procesarEventosCitas(deps);
    expect(await procesarEventosCitas(deps)).toMatchObject({ eventos: 0 });
    await db.sql.query(`update shared.outbox_consumidores set ultimo_id = 0 where consumidor = $1`, [CONSUMIDOR]);
    expect(await procesarEventosCitas(deps)).toMatchObject({ eventos: 1 });
    expect(await mensajes()).toHaveLength(3);
  });

  it('usa el canal preferido y los recordatorios configurados por la vacante', async () => {
    await guardarReglas(db.sql, vacanteId, { mensajes: { canal_preferido: 'email', recordatorios: { h24: { activo: false, horas_antes: 24 }, h2: { activo: true, horas_antes: 2 } } } });
    await publicar('CitaConfirmada', confirmada());
    await procesarEventosCitas(deps);
    const ms = await mensajes();
    expect(ms.map((m) => m.tipo)).toEqual(['confirmacion', 'recordatorio_2h']);
    expect(ms.every((m) => m.canal === 'email')).toBe(true);
  });
});

describe('M7 · cancelación y reprogramación', () => {
  it('CitaCancelada → cancela los recordatorios pendientes y encola la cancelación', async () => {
    await publicar('CitaConfirmada', confirmada());
    await publicar('CitaCancelada', { cita_id: CITA, lead_id: LEAD, vacante_id: vacanteId, cliente_id: clienteId, motivo: 'candidato' });
    expect(await procesarEventosCitas(deps)).toMatchObject({ eventos: 2, cancelados: 3, encolados: 4 });
    const ms = await mensajes();
    expect(ms.filter((m) => m.tipo.startsWith('recordatorio')).every((m) => m.estado === 'cancelado')).toBe(true);
    expect(ms.find((m) => m.tipo === 'cancelacion')).toMatchObject({ estado: 'pendiente', variables: null });
  });

  it('CitaReprogramada → cancela los de la cita anterior, avisa y programa los de la nueva', async () => {
    await publicar('CitaConfirmada', confirmada());
    await publicar('CitaReprogramada', {
      cita_id: CITA_NUEVA, cita_anterior_id: CITA, lead_id: LEAD, vacante_id: vacanteId, cliente_id: clienteId,
      inicio: '2026-11-20T16:00:00.000Z', fin: '2026-11-20T16:30:00.000Z', folio: 'AS-0001', nombre_pila: 'Ana',
    });
    await procesarEventosCitas(deps);
    const ms = await mensajes();
    const anteriores = ms.filter((m) => m.cita_id === CITA && m.tipo.startsWith('recordatorio'));
    expect(anteriores.every((m) => m.estado === 'cancelado')).toBe(true);
    const nuevos = ms.filter((m) => m.cita_id === CITA_NUEVA);
    expect(nuevos.map((m) => m.tipo).sort()).toEqual(['recordatorio_24h', 'recordatorio_2h', 'reprogramacion']);
    expect(nuevos.find((m) => m.tipo === 'reprogramacion')!.variables).toMatchObject({ fecha: 'viernes, 20 de noviembre', hora: '10:00' });
  });

  it('cita ya pasada o inminente → sin recordatorios', async () => {
    await publicar('CitaConfirmada', confirmada({ inicio: '2026-11-16T18:00:00.000Z' }));
    await procesarEventosCitas(deps);
    expect((await mensajes()).map((m) => m.tipo)).toEqual(['confirmacion']);
  });
});

describe('AsistenciaRegistrada → agradecimiento', () => {
  it('asistió → agradecimiento; no asistió → nada', async () => {
    await publicar('AsistenciaRegistrada', { cita_id: CITA, lead_id: LEAD, vacante_id: vacanteId, cliente_id: clienteId, asistio: true, event_id: 'e' });
    await publicar('AsistenciaRegistrada', { cita_id: CITA_NUEVA, lead_id: LEAD, vacante_id: vacanteId, cliente_id: clienteId, asistio: false, event_id: 'e2' });
    expect(await procesarEventosCitas(deps)).toMatchObject({ eventos: 2, encolados: 1 });
    expect((await mensajes()).map((m) => m.tipo)).toEqual(['agradecimiento']);
  });

  it('un evento con payload inválido no bloquea el cursor (se registra y se salta)', async () => {
    const logs: string[] = [];
    await publicar('CitaConfirmada', { cita_id: 'no-uuid' });
    await publicar('AsistenciaRegistrada', { cita_id: CITA, lead_id: LEAD, vacante_id: vacanteId, cliente_id: clienteId, asistio: true, event_id: 'e' });
    const r = await procesarEventosCitas({ ...deps, logger: crearLogger({}, (l) => logs.push(l)) });
    expect(r).toMatchObject({ eventos: 2, invalidos: 1, encolados: 1 });
    expect(logs.some((l) => l.includes('evento inválido'))).toBe(true);
  });
});
