/**
 * Dashboard (DSH-01..03, DSH-06, S1) contra PGlite. Los datos se siembran SOLO con las APIs públicas
 * de cada dominio: tracking.registrar_evento (SQL), citas.retenerSlot/confirmarCita (TS) +
 * citas.registrar_asistencia (SQL) y comunicacion.encolarMensaje + procesarLote (TS).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { ok } from '@shared/result.ts';
import type { SqlClient } from '@shared/sql.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante } from '@test/db/fixtures';
import { confirmarCita, retenerSlot } from '@domains/citas/index.ts';
import { crearReglasVacanteSql, encolarMensaje, procesarLote } from '@domains/comunicacion/index.ts';
import { cargarDashboard } from '../application/cargarDashboard.ts';
import { crearFuenteDashboardSql } from './fuenteSql.ts';

let db: TestDb;
let A: { vacanteId: string; clienteId: string };
let B: { vacanteId: string; clienteId: string };
let admin: string;
let reclA: string;
let clienteB: string;
const clock = new FixedClock(new Date('2026-11-17T02:00:00Z')); // lunes 16-nov 20:00 CDMX
const DIA = '2026-11-17';

async function evento(vacante: string, nombre: string, n: number, extra: Record<string, unknown> = {}) {
  for (let i = 0; i < n; i++) {
    await db.servicio.query(`select tracking.registrar_evento($1::jsonb, '{}')`, [
      JSON.stringify({ event_id: globalThis.crypto.randomUUID(), nombre, fuente: 'servidor', consentimiento: true, vacante_ref: vacante, origen: 'meta_pagado', utm_campaign: 'camp-1', creado_en: `${DIA}T18:00:00Z`, ...extra }),
    ]);
  }
}

async function citaConfirmada(vacanteId: string, inicio: string): Promise<string> {
  const leadId = globalThis.crypto.randomUUID();
  return db.servicio.transaction(async (tx) => {
    const r = await retenerSlot(tx, { vacanteId, leadId, inicio }, clock);
    if (!r.ok) throw new Error(r.error);
    const c = await confirmarCita(tx, { citaId: r.value.citaId, folio: '369-ABCDEF', nombrePila: 'Ana', eventId: globalThis.crypto.randomUUID() }, clock);
    if (!c.ok) throw new Error(c.error);
    return r.value.citaId;
  });
}

async function mensajesConCosto(v: { vacanteId: string; clienteId: string }, n: number) {
  for (let i = 0; i < n; i++) {
    await db.servicio.transaction((tx) =>
      encolarMensaje(tx, { tipo: 'agradecimiento', canal: 'whatsapp', leadId: globalThis.crypto.randomUUID(), vacanteId: v.vacanteId, clienteId: v.clienteId, llave: `dsh-${v.vacanteId}-${i}` }),
    );
  }
  await procesarLote({
    sql: db.servicio,
    clock: new FixedClock(new Date(`${DIA}T18:00:00Z`)), // 12:00 CDMX, dentro de la ventana
    canales: { whatsapp: { proveedor: 'evolution', enviarTexto: async () => ok({ proveedorId: 'wa-1', costoMxn: 0.5 }) } },
    contactos: { obtener: async () => ({ telefonoE164: '+528111111111', email: null, nombrePila: 'Ana', folio: '369-ABCDEF' }) },
    reglas: crearReglasVacanteSql(db.servicio),
    otpKey: btoa('x'.repeat(32)),
    pepper: 'p'.repeat(32),
    logger: crearLogger({}, () => {}),
  });
}

const refrescar = () => db.servicio.query('select dashboard.refrescar()');
const kpisComo = (u: string) => db.comoUsuario(u, (s) => s.query<{ vacante_id: string; leads: number }>('select vacante_id, leads from dashboard.api_kpis_diarios order by vacante_id'));

beforeEach(async () => {
  db = await crearTestDb();
  A = await crearVacante(db.sql, { slug: 'dsh-a' });
  B = await crearVacante(db.sql, { slug: 'dsh-b' });
  admin = await crearUsuario(db.sql, 'admin');
  reclA = await crearUsuario(db.sql, 'reclutador', { clienteId: A.clienteId, vacantes: [A.vacanteId] });
  clienteB = await crearUsuario(db.sql, 'cliente', { clienteId: B.clienteId, vacantes: [B.vacanteId] });

  await evento(A.vacanteId, 'PageView', 4);
  await evento(A.vacanteId, 'FormSubmitted', 2);
  await evento(A.vacanteId, 'LeadCreado', 2);
  await evento(A.vacanteId, 'WhatsAppVerificado', 1);
  await evento(A.vacanteId, 'CitaConfirmada', 2);
  await evento(A.vacanteId, 'LeadCreado', 1, { utm_campaign: 'camp-2', origen: 'organico_google' });
  await evento(B.vacanteId, 'LeadCreado', 1);
  await evento('vacante-que-no-existe', 'PageView', 1);

  const c1 = await citaConfirmada(A.vacanteId, '2026-11-17T16:00:00.000Z');
  const c2 = await citaConfirmada(A.vacanteId, '2026-11-17T16:30:00.000Z');
  await citaConfirmada(B.vacanteId, '2026-11-17T16:00:00.000Z');
  await db.comoUsuario(reclA, async (s) => {
    await s.query('select citas.registrar_asistencia($1, true, $2::jsonb)', [c1, JSON.stringify({ calificacion: 4 })]);
    await s.query('select citas.registrar_asistencia($1, false, null)', [c2]);
  });

  await mensajesConCosto(A, 2);
  await mensajesConCosto(B, 1);
}, 120_000);
afterEach(async () => { await db?.close(); });

describe('vistas del dashboard (DSH-01..03)', () => {
  it('son materializadas: no ven datos hasta el refresco programado', async () => {
    expect((await kpisComo(admin)).rows).toEqual([]);
    await refrescar();
    expect((await kpisComo(admin)).rows.length).toBeGreaterThan(0);
  });

  it('KPIs diarios combinan funnel (tracking), ocupación (citas) y costos (comunicacion)', async () => {
    await refrescar();
    const { rows } = await db.comoUsuario(admin, (s) =>
      s.query<Record<string, number | string | null>>(`select * from dashboard.api_kpis_diarios where vacante_id = $1 and dia = $2`, [A.vacanteId, DIA]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cliente_id: A.clienteId, visitas: 4, formularios: 2, leads: 3, verificados: 1, citas_confirmadas: 2,
      confirmadas: 0, asistio: 1, no_asistio: 1, retenidas: 0, cupo: 10,
    });
    const costos = await db.comoUsuario(admin, (s) => s.query<{ costo: string; intentos: number }>(`select sum(costo_mxn)::text as costo, sum(intentos)::int as intentos from dashboard.api_kpis_diarios where vacante_id = $1`, [A.vacanteId]));
    expect(Number(costos.rows[0]!.costo)).toBeCloseTo(1.0);
    expect(costos.rows[0]!.intentos).toBe(2);
  });

  it('funnel por vacante, cliente, campaña y origen', async () => {
    await refrescar();
    const { rows } = await db.comoUsuario(admin, (s) =>
      s.query<{ campana: string | null; origen: string; evento: string; eventos: number }>(`select campana, origen, evento, eventos::int from dashboard.api_funnel where vacante_id = $1 and evento = 'LeadCreado' order by campana`, [A.vacanteId]),
    );
    expect(rows).toEqual([
      { campana: 'camp-1', origen: 'meta_pagado', evento: 'LeadCreado', eventos: 2 },
      { campana: 'camp-2', origen: 'organico_google', evento: 'LeadCreado', eventos: 1 },
    ]);
  });
});

describe('S1 / DSH-06 sobre las vistas del dashboard', () => {
  beforeEach(async () => { await refrescar(); });

  it('reclutador de A solo ve A; cliente de B solo B; admin todo (incluida la vacante desconocida)', async () => {
    expect([...new Set((await kpisComo(reclA)).rows.map((r) => r.vacante_id))]).toEqual([A.vacanteId]);
    expect([...new Set((await kpisComo(clienteB)).rows.map((r) => r.vacante_id))]).toEqual([B.vacanteId]);
    expect(new Set((await kpisComo(admin)).rows.map((r) => r.vacante_id))).toEqual(new Set([A.vacanteId, B.vacanteId]));

    const f = async (u: string) => (await db.comoUsuario(u, (s) => s.query<{ vacante_id: string | null }>('select distinct vacante_id from dashboard.api_funnel'))).rows.map((r) => r.vacante_id);
    expect(await f(reclA)).toEqual([A.vacanteId]);
    expect(await f(clienteB)).toEqual([B.vacanteId]);
    expect(await f(admin)).toContain(null);
  });

  it('nadie lee las vistas materializadas directamente; anon no lee nada; el cliente no refresca', async () => {
    for (const mv of ['dashboard.mv_kpis_diarios', 'dashboard.mv_funnel']) {
      await expect(db.comoUsuario(admin, (s) => s.query(`select * from ${mv}`))).rejects.toThrow(/permission denied/);
    }
    for (const v of ['dashboard.api_kpis_diarios', 'dashboard.api_funnel']) {
      await expect(db.como('anon', null, (s) => s.query(`select * from ${v}`))).rejects.toThrow(/permission denied/);
    }
    await expect(db.comoUsuario(clienteB, (s) => s.query('select dashboard.refrescar()'))).rejects.toThrow(/permission denied/);
  });
});

describe('cargarDashboard (application) con la fuente SQL como el usuario', () => {
  const fuente = (s: SqlClient) => crearFuenteDashboardSql(s);

  it('DSH-02/03: costo por lead/verificado/asistencia, ocupación x/cupo, no-show y verificación OTP', async () => {
    await refrescar();
    const d = await db.comoUsuario(reclA, (s) => cargarDashboard(fuente(s), { desde: '2026-11-01', hasta: '2026-11-30' }));
    expect(d.kpis.leads).toBe(3);
    expect(d.kpis.costoMxn).toBeCloseTo(1.0);
    expect(d.kpis.costoPorLead).toBeCloseTo(1 / 3);
    expect(d.kpis.costoPorVerificado).toBeCloseTo(1);
    expect(d.kpis.costoPorAsistencia).toBeCloseTo(1);
    expect(d.kpis.ocupacion).toEqual({ ocupadas: 2, cupo: 10, tasa: 0.2 });
    expect(d.kpis.tasaNoShow).toBeCloseTo(0.5);
    expect(d.kpis.tasaVerificacion).toBeCloseTo(1 / 3);
    expect(d.porVacante.map((v) => v.vacanteId)).toEqual([A.vacanteId]);
    expect(d.funnel.find((g) => g.clave === 'camp-1')?.etapas.find((e) => e.evento === 'LeadCreado')?.total).toBe(2);
    expect(d.refrescadoEn).not.toBeNull();
  });

  it('filtra por vacante y por rango de fechas', async () => {
    await refrescar();
    const vacio = await db.comoUsuario(admin, (s) => cargarDashboard(fuente(s), { desde: '2026-12-01', hasta: '2026-12-31' }));
    expect(vacio.kpis.leads).toBe(0);
    expect(vacio.kpis.costoPorLead).toBeNull();
    const soloB = await db.comoUsuario(admin, (s) => cargarDashboard(fuente(s), { desde: '2026-11-01', hasta: '2026-11-30', vacanteId: B.vacanteId }));
    expect(soloB.kpis.leads).toBe(1);
    expect(soloB.porVacante.map((v) => v.vacanteId)).toEqual([B.vacanteId]);
  });
});
