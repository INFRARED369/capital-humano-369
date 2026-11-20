/**
 * Política de retención de datos de extremo a extremo (PGlite con TODAS las migraciones): R1–R8 + OTP 24 h,
 * bitácora 90 días y evento de Zoho a cita + 30 días. Los datos se siembran con las APIs/SQL de cada dominio
 * (captación por SQL como su repositorio, citas.retener + confirmarCita, encolarMensaje, tracking.registrar_*,
 * el worker real de Zoho con un calendario en memoria) y se ejecuta el caso de uso real de privacidad.
 *
 * Las brechas de otros dominios detectadas aquí se cerraron en la migración 20261113070001_integracion_privacidad.sql.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { hmacSha256Hex } from '@shared/crypto.ts';
import { crearLogger, redactar } from '@shared/logger.ts';
import { ok } from '@shared/result.ts';
import type { SqlClient } from '@shared/sql.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante, guardarReglas } from '@test/db/fixtures';
import { obtenerContactoLead } from '@domains/captacion/index.ts';
import { confirmarCita, crearDepsZohoSql, ejecutarWorkerZoho, firmarLinkGestion, type CalendarioExternoPort, type EventoRemoto } from '@domains/citas/index.ts';
import { crearLinksGestion, crearReglasVacanteSql, encolarMensaje, procesarEventosCitas } from '@domains/comunicacion/index.ts';
import {
  crearContactosDesdeCaptacion, crearHandlerArco, crearHandlerRetencion, crearRepoPrivacidadSql, ejecutarRetencionDiaria, type DepsPrivacidad,
} from '../index.ts';

const HORA = 3_600_000;
const DIA = 24 * HORA;
const PEPPER = 'pepper-de-prueba-de-32-caracteres!!';
const CAL = 'c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
const TELEFONO = '528112345678';
const uuid = () => globalThis.crypto.randomUUID();
const silencio = crearLogger({}, () => {});

/** JSON devuelto por las funciones SQL (forma dinámica, se inspecciona con expect). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let db: TestDb;
let AHORA: Date;
beforeEach(async () => {
  db = await crearTestDb();
  AHORA = new Date(Date.now() + HORA);
}, 120_000);
afterEach(async () => { await db?.close(); });

// ---------------------------------------------------------------------------------------------
// Calendario externo en memoria (implementa el puerto público CalendarioExternoPort de citas/zoho)
// ---------------------------------------------------------------------------------------------
class CalendarioMemoria implements CalendarioExternoPort {
  eventos = new Map<string, EventoRemoto & { cal: string }>();
  async crear(cal: string, e: Parameters<CalendarioExternoPort['crear']>[1]) {
    const r = { uid: uuid(), etag: '1', titulo: e.titulo, descripcion: e.descripcion, inicio: e.inicio, fin: e.fin, uidPropio: e.uidPropio, numAsistentes: 0 };
    this.eventos.set(r.uid, { ...r, cal });
    return ok(r);
  }
  async actualizar(cal: string, uid: string, _etag: string, e: Parameters<CalendarioExternoPort['crear']>[1]) {
    const r = { uid, etag: '2', titulo: e.titulo, descripcion: e.descripcion, inicio: e.inicio, fin: e.fin, uidPropio: e.uidPropio, numAsistentes: 0 };
    this.eventos.set(uid, { ...r, cal });
    return ok(r);
  }
  async borrar(_cal: string, uid: string) { this.eventos.delete(uid); return ok(undefined); }
  async obtener(_cal: string, uid: string) { return ok(this.eventos.get(uid) ?? null); }
  async listar(cal: string) { return ok([...this.eventos.values()].filter((e) => e.cal === cal)); }
}

// ---------------------------------------------------------------------------------------------
// Siembra con las APIs/SQL de cada dominio
// ---------------------------------------------------------------------------------------------
const FOLIO_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const folio = () => `369-${Array.from({ length: 6 }, () => FOLIO_ALFABETO[Math.floor(Math.random() * FOLIO_ALFABETO.length)]).join('')}`;

interface Lead { id: string; folio: string; hmac: string; eventId: string; visitor: string; vacanteId: string; clienteId: string }

/** Como captacion/infra/sql/repo.insertarLead + publicar LeadCreado (postular). */
async function sembrarLead(v: { vacanteId: string; clienteId: string }, o: { postulado: Date; verificado?: Date; telefono?: string }): Promise<Lead> {
  const tel = o.telefono ?? TELEFONO;
  const l: Lead = { id: uuid(), folio: folio(), hmac: await hmacSha256Hex(PEPPER, tel), eventId: uuid(), visitor: uuid(), ...v };
  await db.servicio.query(
    `insert into captacion.leads (id, cliente_id, vacante_id, folio, nombre, nombre_pila, telefono, telefono_hmac, email, respuestas,
       consentimiento_version, consentido_en, atribucion, visitor_id, event_id, estado, verificado_en, postulado_en, creado_en, actualizado_en)
     values ($1, $2, $3, $4, 'mariana garza', 'Mariana', $5, $6, 'mariana@correo.mx', '{"edad": 22}', '2026-11-13', $7, '{"utm_source":"facebook"}', $8, $9,
       $10, $11, $7, $7, $7)`,
    [l.id, l.clienteId, l.vacanteId, l.folio, tel, l.hmac, o.postulado.toISOString(), l.visitor, l.eventId, o.verificado ? 'verificado' : 'pendiente_otp', o.verificado?.toISOString() ?? null],
  );
  await db.servicio.query(`select shared.publicar_evento('LeadCreado', $1::jsonb, $2)`,
    [JSON.stringify({ lead_id: l.id, vacante_id: l.vacanteId, cliente_id: l.clienteId, folio: l.folio, event_id: l.eventId, visitor_id: l.visitor, origen: 'facebook' }), l.clienteId]);
  // OTP (solo hash) y registro de rate limit (HMAC del teléfono)
  await db.servicio.query(`insert into captacion.otp (id, cliente_id, lead_id, codigo_hash, expira_en, creado_en) values ($1, $2, $3, $4, $5::timestamptz + interval '10 min', $5)`,
    [uuid(), l.clienteId, l.id, 'f'.repeat(64), o.postulado.toISOString()]);
  await db.servicio.query(`insert into captacion.envios_limitados (cliente_id, tipo, telefono_hmac, ip_hmac, lead_id, creado_en) values ($1, 'otp', $2, $3, $4, $5)`,
    [l.clienteId, l.hmac, 'e'.repeat(64), l.id, o.postulado.toISOString()]);
  // Tracking: visita con consentimiento (IP y UA) + vínculo lead ↔ visitante (consumidor LeadCreado)
  await db.servicio.query(`select tracking.registrar_evento($1::jsonb)`, [JSON.stringify({
    event_id: uuid(), nombre: 'PageView', fuente: 'navegador', consentimiento: true, visitor_id: l.visitor, vacante_ref: l.vacanteId,
    ip: '189.203.1.2', user_agent: 'Mozilla/5.0', origen: 'meta_pagado', utm_campaign: 'nov', creado_en: new Date(o.postulado.getTime() - HORA).toISOString(),
  })]);
  await db.servicio.query(`select tracking.registrar_evento($1::jsonb)`, [JSON.stringify({
    event_id: l.eventId, nombre: 'Lead', fuente: 'servidor', consentimiento: true, visitor_id: l.visitor, lead_id: l.id, vacante_ref: l.vacanteId,
    origen: 'meta_pagado', utm_campaign: 'nov', creado_en: o.postulado.toISOString(),
  })]);
  await db.servicio.query(`select tracking.registrar_lead($1::jsonb)`, [JSON.stringify({ lead_id: l.id, visitor_id: l.visitor, event_id: l.eventId, vacante_ref: l.vacanteId })]);
  return l;
}

/** citas.retener (SQL del dominio). Devuelve el id de la cita retenida. */
async function retener(l: Lead, inicio: Date, ahora: Date, capacidad = 1): Promise<string> {
  const { rows } = await db.servicio.query<{ r: { ok?: boolean; cita_id?: string; error?: string } }>(
    `select citas.retener($1, $2, $3::timestamptz, $3::timestamptz + interval '90 min', ($3::timestamptz at time zone 'America/Mexico_City')::date,
       $4, 10, true, 0, $5::timestamptz + interval '10 min', $5::timestamptz) as r`,
    [l.vacanteId, l.id, inicio.toISOString(), capacidad, ahora.toISOString()]);
  const r = rows[0]!.r;
  if (!r.cita_id) throw new Error(`retener: ${JSON.stringify(r)}`);
  return r.cita_id;
}

async function confirmar(l: Lead, citaId: string, ahora: Date) {
  const r = await db.servicio.transaction((tx) => confirmarCita(tx, { citaId, folio: l.folio, nombrePila: 'Mariana', eventId: uuid() }, new FixedClock(ahora)));
  if (!r.ok) throw new Error(r.error);
}

async function zoho(cal: CalendarioMemoria) {
  return ejecutarWorkerZoho(crearDepsZohoSql({ sql: db.servicio, calendario: cal, clock: new FixedClock(new Date()), logger: silencio, panelUrl: 'https://panel.369.mx' }));
}

async function retencion(ahora = AHORA) {
  return ejecutarRetencionDiaria({ repo: crearRepoPrivacidadSql(db.servicio), clock: new FixedClock(ahora), logger: silencio });
}

/** Tablas (de todos los schemas de la app) cuyo texto de fila contiene `valor`. */
async function rastro(valor: string, excluir: string[] = []): Promise<string[]> {
  const { rows } = await db.sql.query<{ t: string }>(
    `select table_schema || '.' || table_name as t from information_schema.tables
     where table_schema in ('shared','config','captacion','citas','comunicacion','tracking','dashboard','privacidad') and table_type = 'BASE TABLE'`);
  const hallazgos: string[] = [];
  for (const { t } of rows) {
    if (excluir.includes(t)) continue;
    const r = await db.sql.query<{ n: number }>(`select count(*)::int as n from ${t} x where x::text ilike $1`, [`%${valor}%`]);
    if (r.rows[0]!.n > 0) hallazgos.push(t);
  }
  return hallazgos.sort();
}

const funnel = async (vacanteId: string) =>
  (await db.servicio.query<{ evento: string; n: string }>(
    `select evento, sum(eventos)::text as n from tracking.api_funnel_diario where vacante_id = $1 group by evento order by evento`, [vacanteId])).rows;

const PII = (l: Lead) => [TELEFONO, '8112345678', l.hmac, 'mariana garza', 'mariana@correo.mx'];

// ---------------------------------------------------------------------------------------------
describe('R1 · lead sin OTP verificado de hace 49 h', () => {
  it('corre el cron: no queda PII ni HMAC en ninguna tabla y el conteo anónimo sigue igual', async () => {
    const v = await crearVacante(db.sql);
    const t0 = new Date(AHORA.getTime() - 49 * HORA);
    const l = await sembrarLead(v, { postulado: t0 });
    await retener(l, new Date(AHORA.getTime() + DIA), t0);
    await encolarMensaje(db.servicio, { tipo: 'otp', canal: 'whatsapp', leadId: l.id, vacanteId: v.vacanteId, clienteId: v.clienteId, llave: `otp:${uuid()}`, codigoCifrado: 'v1.aaaa.bbbb' });
    const antes = await funnel(v.vacanteId);
    const citasAntes = (await db.sql.query('select 1 from citas.citas')).rows.length;
    for (const x of PII(l)) expect((await rastro(x)).length, x).toBeGreaterThan(0);

    const r = await retencion();
    expect(r.conteos).toMatchObject({ captacion: { leads_sin_verificar_48h: 1 }, privacidad: { outbox_suprimidos: 1 } });

    for (const x of PII(l)) expect(await rastro(x), x).toEqual([]);
    // El id del lead solo sobrevive en el outbox (brecha de plataforma) y en el barrido temporal (3 días).
    expect(await rastro(l.id)).toEqual(['privacidad.barridos', 'shared.outbox']);
    expect(await funnel(v.vacanteId)).toEqual(antes);
    expect((await db.sql.query('select 1 from citas.citas')).rows.length).toBe(citasAntes);
  });
});

describe('R2 · lead sin OTP verificado de hace 49 h', () => {
  it('corre el cron: se borra el lead y el slot queda libre', async () => {
    const v = await crearVacante(db.sql);
    const t0 = new Date(AHORA.getTime() - 49 * HORA);
    const l = await sembrarLead(v, { postulado: t0 });
    const inicio = new Date(Math.ceil((AHORA.getTime() + 2 * DIA) / HORA) * HORA);
    await retener(l, inicio, t0);
    await retencion();
    expect((await db.sql.query('select 1 from captacion.leads where id = $1', [l.id])).rows).toHaveLength(0);
    const ocup = await db.servicio.query<{ retenidas: number; confirmadas: number }>(
      `select retenidas, confirmadas from citas.api_ocupacion_diaria where vacante_id = $1`, [v.vacanteId]);
    expect(ocup.rows.every((o) => Number(o.retenidas) === 0 && Number(o.confirmadas) === 0)).toBe(true);
    // otro candidato puede tomar el mismo slot (capacidad 1)
    const otro = await sembrarLead(v, { postulado: AHORA, telefono: '528119999999' });
    await expect(retener(otro, inicio, AHORA)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('R3 · cita no asistida de hace 61 días', () => {
  async function citaNoAsistida(dias: number, cal: CalendarioMemoria) {
    const v = await crearVacante(db.sql);
    await guardarReglas(db.sql, v.vacanteId, { zoho_calendar_uid: CAL });
    const inicio = new Date(AHORA.getTime() - dias * DIA);
    const l = await sembrarLead(v, { postulado: new Date(inicio.getTime() - 2 * DIA), verificado: new Date(inicio.getTime() - 2 * DIA + 60_000) });
    const t = new Date(inicio.getTime() - DIA);
    const citaId = await retener(l, inicio, t);
    await confirmar(l, citaId, new Date(t.getTime() + 60_000));
    await zoho(cal); // el worker crea el evento en Zoho
    expect(cal.eventos.size).toBe(1);
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId: v.clienteId, vacantes: [v.vacanteId] });
    await db.comoUsuario(reclutador, (s) => s.query('select citas.registrar_asistencia($1, false)', [citaId]));
    await encolarMensaje(db.servicio, { tipo: 'confirmacion', canal: 'whatsapp', leadId: l.id, vacanteId: v.vacanteId, clienteId: v.clienteId, citaId, llave: `confirmacion:${citaId}`, variables: { fecha: 'lunes', hora: '10:00' } });
    return { v, l, citaId, reclutador };
  }

  it('corre el cron: lead anonimizado (captación, citas, comunicación, tracking) y evento de Zoho borrado', async () => {
    const cal = new CalendarioMemoria();
    const { l, citaId } = await citaNoAsistida(61, cal);
    const r = await retencion();
    expect(r.conteos).toMatchObject({ citas: { cancelada_no_asistio_60d: 1, zoho: { zoho_evento_cita_30d: 1, borrados_encolados: 1 } },
      privacidad: { ciclo_anonimizados: 1 } });
    const lead = (await db.sql.query<Record<string, unknown>>('select * from captacion.leads where id = $1', [l.id])).rows[0]!;
    expect(lead).toMatchObject({ nombre: null, nombre_pila: null, telefono: null, telefono_hmac: null, email: null, respuestas: null, visitor_id: null });
    expect((await db.sql.query<{ lead_id: string | null }>('select lead_id from citas.citas where id = $1', [citaId])).rows[0]!.lead_id).toBeNull();
    expect((await db.sql.query('select 1 from comunicacion.mensajes where lead_id = $1', [l.id])).rows).toHaveLength(0);
    expect((await db.sql.query('select 1 from tracking.leads where lead_id = $1', [l.id])).rows).toHaveLength(0);
    expect((await db.sql.query<{ nombre_pila: string | null; vigente: boolean }>('select nombre_pila, vigente from citas.zoho_eventos where cita_id = $1', [citaId])).rows[0])
      .toEqual({ nombre_pila: null, vigente: false });
    await zoho(cal);
    expect(cal.eventos.size).toBe(0);
    for (const x of PII(l)) expect(await rastro(x, ['shared.outbox']), x).toEqual([]);
  });

  it('a los 59 días todavía no se anonimiza, pero el lead está bloqueado (solo admin)', async () => {
    const cal = new CalendarioMemoria();
    const { l } = await citaNoAsistida(59, cal);
    const r = await retencion();
    expect(r.conteos.privacidad).toMatchObject({ ciclo_bloqueados: 1, ciclo_anonimizados: 0 });
    expect((await db.sql.query<{ nombre: string }>('select nombre from captacion.leads where id = $1', [l.id])).rows[0]!.nombre).toBe('mariana garza');
    expect((await db.servicio.query<{ b: boolean }>('select privacidad.api_lead_bloqueado($1) as b', [l.id])).rows[0]!.b).toBe(true);
  });

  it('captación: durante el bloqueo el reclutador NO debería ver la PII del lead (RLS de captacion.leads)', async () => {
    const cal = new CalendarioMemoria();
    const { l, reclutador } = await citaNoAsistida(45, cal);
    await retencion();
    const vis = await db.comoUsuario(reclutador, (s) => s.query('select telefono from captacion.api_leads_panel where id = $1', [l.id]));
    expect(vis.rows).toHaveLength(0);
    // y directo de la tabla, ninguna columna de PII es legible para el panel
    await expect(db.comoUsuario(reclutador, (s) => s.query('select telefono from captacion.leads where id = $1', [l.id]))).rejects.toThrow(/permission denied/);
  });

  it('plataforma: el outbox NO conserva nombre de pila y folio de CitaConfirmada después de anonimizar', async () => {
    const cal = new CalendarioMemoria();
    const { l } = await citaNoAsistida(61, cal);
    await retencion();
    expect(await rastro('Mariana')).toEqual([]);
    expect(await rastro(l.folio, ['captacion.leads'])).toEqual([]);
  });

});

describe('Lead contratado · hasta la entrega al cliente (máx. 30 días) + bloqueo de 30 días → anonimización', () => {
  /** Cita asistida hace `dias` días y contratación registrada por el reclutador (dashboard.registrar_contratacion). */
  async function contratado(dias: number, entregar: boolean) {
    const v = await crearVacante(db.sql);
    const inicio = new Date(AHORA.getTime() - dias * DIA);
    const l = await sembrarLead(v, { postulado: new Date(inicio.getTime() - 2 * DIA), verificado: new Date(inicio.getTime() - 2 * DIA + 60_000) });
    const t = new Date(inicio.getTime() - DIA);
    const citaId = await retener(l, inicio, t);
    await confirmar(l, citaId, new Date(t.getTime() + 60_000));
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId: v.clienteId, vacantes: [v.vacanteId] });
    await db.comoUsuario(reclutador, (s) => s.query('select citas.registrar_asistencia($1, true)', [citaId]));
    await db.comoUsuario(reclutador, (s) => s.query('select dashboard.registrar_contratacion($1, false)', [citaId]));
    if (entregar) await db.comoUsuario(reclutador, (s) => s.query('select dashboard.registrar_contratacion($1, true)', [citaId]));
    return { v, l, citaId, reclutador };
  }
  const etapa = async (lead: string) =>
    (await db.sql.query<{ etapa: string }>('select etapa from privacidad.ciclo_vida where lead_id = $1', [lead])).rows[0]?.etapa ?? null;
  const contratacion = async (citaId: string) =>
    (await db.sql.query<{ lead_id: string | null }>('select lead_id from dashboard.contrataciones where cita_id = $1', [citaId])).rows[0]!;

  it('expediente entregado: bloqueado desde la entrega (el reclutador ya no ve la PII) y anonimizado a los 30 días', async () => {
    const { l, citaId, reclutador } = await contratado(3, true);
    let r = await retencion(new Date(AHORA.getTime() + 29 * DIA));
    expect(await etapa(l.id)).toBe('entregado');
    expect(r.conteos.privacidad).toMatchObject({ ciclo_bloqueados: 1, ciclo_anonimizados: 0 });
    expect((await db.servicio.query<{ b: boolean }>('select privacidad.api_lead_bloqueado($1) as b', [l.id])).rows[0]!.b).toBe(true);
    expect((await db.comoUsuario(reclutador, (s) => s.query('select telefono from captacion.api_leads_panel where id = $1', [l.id]))).rows).toHaveLength(0);
    expect((await contratacion(citaId)).lead_id).toBe(l.id);

    r = await retencion(new Date(AHORA.getTime() + 31 * DIA));
    expect(r.conteos.privacidad).toMatchObject({ ciclo_anonimizados: 1 });
    expect((r.conteos as Json).privacidad.anonimizacion).toHaveProperty('dashboard');
    expect((await db.sql.query<Record<string, unknown>>('select nombre, telefono, telefono_hmac from captacion.leads where id = $1', [l.id])).rows[0])
      .toEqual({ nombre: null, telefono: null, telefono_hmac: null });
    expect((await contratacion(citaId)).lead_id).toBeNull();
    expect(await etapa(l.id)).toBeNull();
    for (const x of PII(l)) expect(await rastro(x, ['shared.outbox']), x).toEqual([]);
  });

  it('sin entrega: el plazo activo no pasa de 30 días desde la contratación (+30 de bloqueo)', async () => {
    const { l } = await contratado(3, false);
    await retencion(new Date(AHORA.getTime() + 29 * DIA));
    expect(await etapa(l.id)).toBe('contratado');
    expect((await db.servicio.query<{ b: boolean }>('select privacidad.api_lead_bloqueado($1) as b', [l.id])).rows[0]!.b).toBe(false);
    const r31 = await retencion(new Date(AHORA.getTime() + 31 * DIA));
    expect(r31.conteos.privacidad).toMatchObject({ ciclo_bloqueados: 1, ciclo_anonimizados: 0 });
    const r61 = await retencion(new Date(AHORA.getTime() + 61 * DIA));
    expect(r61.conteos.privacidad).toMatchObject({ ciclo_anonimizados: 1 });
    expect((await db.sql.query<{ nombre: string | null }>('select nombre from captacion.leads where id = $1', [l.id])).rows[0]!.nombre).toBeNull();
  });

  it('ARCO / supresión de un lead contratado también desliga la contratación (dashboard.suprimir_lead)', async () => {
    const { l, citaId } = await contratado(3, false);
    const r = await db.servicio.query<{ r: Json }>('select privacidad.suprimir_lead($1) as r', [l.id]);
    expect(r.rows[0]!.r.conteos).toMatchObject({ dashboard: { contrataciones: 1 } });
    expect((await contratacion(citaId)).lead_id).toBeNull();
  });
});

describe('R4 · evento de tracking de hace 91 días', () => {
  it('corre el cron: se borra el crudo y el agregado coincide', async () => {
    const v = await crearVacante(db.sql);
    for (const dias of [91, 92, 10]) {
      await db.servicio.query(`select tracking.registrar_evento($1::jsonb)`, [JSON.stringify({
        event_id: uuid(), nombre: 'PageView', consentimiento: true, visitor_id: uuid(), vacante_ref: v.vacanteId, ip: '10.1.2.3', origen: 'directo',
        creado_en: new Date(AHORA.getTime() - dias * DIA).toISOString() })]);
    }
    const antes = await funnel(v.vacanteId);
    const r = await retencion();
    expect(r.conteos.tracking).toMatchObject({ R4_eventos_agregados: 2 });
    const crudos = await db.sql.query<{ n: number }>('select count(*)::int as n from tracking.eventos where vacante_id = $1', [v.vacanteId]);
    expect(crudos.rows[0]!.n).toBe(1);
    expect(await funnel(v.vacanteId)).toEqual(antes);
  });
});

describe('R5 · IP de hace 8 días', () => {
  it('corre el cron: IP truncada (IPv4 /24, IPv6 /48); la de 6 días sigue completa', async () => {
    const v = await crearVacante(db.sql);
    const ev = async (ip: string, dias: number) => {
      const id = uuid();
      await db.servicio.query(`select tracking.registrar_evento($1::jsonb)`, [JSON.stringify({
        event_id: id, nombre: 'PageView', consentimiento: true, visitor_id: uuid(), vacante_ref: v.vacanteId, ip, creado_en: new Date(AHORA.getTime() - dias * DIA).toISOString() })]);
      return id;
    };
    const a = await ev('189.203.1.77', 8);
    const b = await ev('2001:db8:abcd:12:1:2:3:4', 8);
    const c = await ev('189.203.1.78', 6);
    await retencion();
    const ip = async (id: string) => (await db.sql.query<{ ip: string }>('select abbrev(ip) as ip from tracking.eventos where event_id = $1', [id])).rows[0]!.ip;
    expect(await ip(a)).toBe('189.203.1.0/24');
    expect(await ip(b)).toBe('2001:db8:abcd::/48');
    expect(await ip(c)).toBe('189.203.1.78');
  });
});

describe('R6 · solicitud ARCO de cancelación (edge function arco)', () => {
  async function escenario() {
    const v = await crearVacante(db.sql);
    await guardarReglas(db.sql, v.vacanteId, { zoho_calendar_uid: CAL });
    const l = await sembrarLead(v, { postulado: new Date(AHORA.getTime() - 2 * DIA), verificado: new Date(AHORA.getTime() - 2 * DIA) });
    const inicio = new Date(Math.ceil((AHORA.getTime() + 3 * DIA) / HORA) * HORA);
    const citaId = await retener(l, inicio, new Date(AHORA.getTime() - 2 * DIA));
    await confirmar(l, citaId, new Date(AHORA.getTime() - 2 * DIA + 60_000));
    const cal = new CalendarioMemoria();
    await zoho(cal);
    for (const tipo of ['confirmacion', 'recordatorio_24h'] as const) {
      await encolarMensaje(db.servicio, { tipo, canal: 'whatsapp', leadId: l.id, vacanteId: v.vacanteId, clienteId: v.clienteId, citaId, llave: `${tipo}:${citaId}`,
        variables: { fecha: 'lunes', hora: '10:00' }, programadoPara: tipo === 'recordatorio_24h' ? new Date(inicio.getTime() - DIA).toISOString() : undefined });
    }
    const logs: string[] = [];
    const log = crearLogger({ funcion: 'arco' }, (x) => logs.push(x));
    const admin = await crearUsuario(db.sql, 'admin');
    const privacidad: DepsPrivacidad = {
      repo: crearRepoPrivacidadSql(db.servicio), contactos: crearContactosDesdeCaptacion(obtenerContactoLead, db.servicio),
      clock: new FixedClock(new Date()), logger: log, pepper: PEPPER,
    };
    const handler = crearHandlerArco({ autenticar: async () => ({ tipo: 'admin', userId: admin }), privacidad, log });
    const post = (body: unknown) => handler(new Request('https://x/arco', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { v, l, citaId, cal, logs, post, privacidad };
  }

  it('se ejecuta: lead, cola y Zoho limpios; opt-out registrado; registro sin PII', async () => {
    const { l, citaId, cal, logs, post } = await escenario();
    const res = await post({ accion: 'registrar', tipo: 'cancelacion', canal: 'correo', lead_id: l.id, ejecutar: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Json;
    expect(body.ejecucion.conteos).toMatchObject({ leads: 1, opt_out: 1, captacion: { leads: 1 }, citas: { canceladas: 1 }, comunicacion: { cancelados: 2 } });

    // lead
    expect((await db.sql.query('select 1 from captacion.leads where id = $1', [l.id])).rows).toHaveLength(0);
    // cola: nada pendiente del lead ni de su cita
    expect((await db.sql.query(`select 1 from comunicacion.mensajes where (lead_id = $1 or cita_id = $2) and estado in ('pendiente','reintento','enviando')`, [l.id, citaId])).rows).toHaveLength(0);
    // Zoho: registro anonimizado y, tras el worker, sin evento
    await zoho(cal);
    expect(cal.eventos.size).toBe(0);
    // opt-out permanente: solo el HMAC
    const opt = await db.sql.query<{ telefono_hmac: string; origen: string }>('select telefono_hmac, origen from comunicacion.opt_out');
    expect(opt.rows).toEqual([{ telefono_hmac: l.hmac, origen: 'arco' }]);
    // registro de supresiones y solicitud: sin PII
    const reg = await db.sql.query<Record<string, unknown>>(`select * from privacidad.registro_supresiones where tipo = 'arco'`);
    expect(reg.rows).toHaveLength(1);
    const sol = await db.sql.query<Record<string, unknown>>('select estado, telefono_hmac from privacidad.solicitudes_arco');
    expect(sol.rows[0]!.estado).toBe('ejecutada');
    for (const x of [TELEFONO, '8112345678', 'mariana']) {
      expect(JSON.stringify(reg.rows) + JSON.stringify(body) + logs.join('\n'), x).not.toContain(x);
    }
    // Después de la corrida diaria, el HMAC solo queda en el opt-out (y en la solicitud hasta 30 días después del cierre)
    for (const x of PII(l).slice(0, 1).concat(['mariana garza', 'mariana@correo.mx'])) expect(await rastro(x), x).toEqual([]);
    expect(await rastro(l.hmac)).toEqual(['comunicacion.opt_out', 'privacidad.solicitudes_arco']);
    await retencion(new Date(AHORA.getTime() + 31 * DIA));
    expect(await rastro(l.hmac)).toEqual(['comunicacion.opt_out']);
  });

  it('defensa en profundidad: un mensaje ligado tarde a un lead ya suprimido se desliga en la corrida diaria', async () => {
    const { v, l, post } = await escenario();
    await post({ accion: 'registrar', tipo: 'revocacion', canal: 'formulario', lead_id: l.id, ejecutar: true });
    // Comunicación ya NO encola el aviso (prueba siguiente); simulamos cualquier otra vía que ligue un mensaje tarde.
    await encolarMensaje(db.servicio, { tipo: 'cancelacion', canal: 'whatsapp', leadId: l.id, vacanteId: v.vacanteId, clienteId: v.clienteId, llave: `tarde:${l.id}` });
    expect((await db.sql.query('select 1 from comunicacion.mensajes where lead_id = $1', [l.id])).rows.length).toBeGreaterThan(0);
    await retencion();
    expect((await db.sql.query('select 1 from comunicacion.mensajes where lead_id = $1', [l.id])).rows).toHaveLength(0);
  });

  it('comunicación: no encolar el aviso de cancelación a un lead suprimido (CitaCancelada motivo supresion)', async () => {
    const { l, post } = await escenario();
    await post({ accion: 'registrar', tipo: 'revocacion', canal: 'formulario', lead_id: l.id, ejecutar: true });
    await procesarEventosCitas({
      sql: db.servicio, clock: new FixedClock(new Date()), reglasEn: (tx: SqlClient) => crearReglasVacanteSql(tx, silencio),
      links: crearLinksGestion(firmarLinkGestion, 'x'.repeat(32), 'https://369.mx'), logger: silencio,
    });
    expect((await db.sql.query(`select 1 from comunicacion.mensajes where tipo = 'cancelacion'`)).rows).toHaveLength(0);
  });

  it('captación: ARCO por teléfono encuentra al lead (falta captacion.api_leads_por_telefono_hmac)', async () => {
    const { l, post } = await escenario();
    const res = await post({ accion: 'registrar', tipo: 'cancelacion', canal: 'correo', telefono: '81 1234 5678', ejecutar: true });
    expect(res.status).toBe(201);
    expect((await db.sql.query('select 1 from captacion.leads where id = $1', [l.id])).rows).toHaveLength(0);
  });

  it('por teléfono sin la API de búsqueda: igual registra el opt-out y reporta el faltante', async () => {
    const { post } = await escenario();
    await db.sql.query('drop function captacion.api_leads_por_telefono_hmac(text)'); // simula un despliegue sin la API
    const res = await post({ accion: 'registrar', tipo: 'cancelacion', canal: 'correo', telefono: '81 1234 5678', ejecutar: true });
    const body = (await res.json()) as Json;
    expect(body.ejecucion.conteos).toMatchObject({ opt_out: 1 });
    expect(body.ejecucion.faltantes).toContain('captacion.api_leads_por_telefono_hmac');
  });

  it('es idempotente: ejecutar de nuevo es 409 y suprimir_lead otra vez no cambia nada', async () => {
    const { l, post } = await escenario();
    const res = await post({ accion: 'registrar', tipo: 'cancelacion', canal: 'correo', lead_id: l.id, ejecutar: true });
    const { solicitud_id } = (await res.json()) as { solicitud_id: string };
    expect((await post({ accion: 'ejecutar', solicitud_id })).status).toBe(409);
    const again = await db.servicio.query<{ r: { conteos: Json } }>('select privacidad.suprimir_lead($1) as r', [l.id]);
    expect(again.rows[0]!.r.conteos).toMatchObject({ captacion: { leads: 0 }, citas: { canceladas: 0, anonimizadas: 0 }, comunicacion: { cancelados: 0 } });
  });
});

describe('R7 · lead anonimizado (prueba de esquema)', () => {
  it('nombre, teléfono, email y respuestas en NULL; solo quedan vacante, fechas, estado e ids técnicos', async () => {
    const v = await crearVacante(db.sql);
    const l = await sembrarLead(v, { postulado: new Date(AHORA.getTime() - 100 * DIA), verificado: new Date(AHORA.getTime() - 100 * DIA) });
    await db.sql.query(`update shared.outbox set creado_en = $1 where payload ->> 'lead_id' = $2`, [new Date(AHORA.getTime() - 100 * DIA).toISOString(), l.id]);
    await db.servicio.query(`select shared.publicar_evento('WhatsAppVerificado', $1::jsonb, $2)`,
      [JSON.stringify({ lead_id: l.id, vacante_id: v.vacanteId, cliente_id: v.clienteId, event_id: uuid() }), v.clienteId]);
    await db.sql.query(`update shared.outbox set creado_en = $1 where tipo = 'WhatsAppVerificado'`, [new Date(AHORA.getTime() - 100 * DIA).toISOString()]);
    const r = await retencion();
    expect(r.conteos.privacidad).toMatchObject({ ciclo_anonimizados: 1 });

    const fila = (await db.sql.query<Record<string, unknown>>('select * from captacion.leads where id = $1', [l.id])).rows[0]!;
    for (const c of ['nombre', 'nombre_pila', 'telefono', 'telefono_hmac', 'email', 'respuestas', 'visitor_id']) expect(fila[c], c).toBeNull();
    const conValor = Object.entries(fila).filter(([, x]) => x !== null).map(([k]) => k).sort();
    const PERMITIDAS = ['id', 'cliente_id', 'vacante_id', 'folio', 'consentimiento_version', 'consentido_en', 'atribucion', 'event_id', 'estado',
      'cita_id', 'cita_inicio', 'verificado_en', 'postulado_en', 'anonimizado_en', 'creado_en', 'actualizado_en'];
    expect(conValor.filter((c) => !PERMITIDAS.includes(c))).toEqual([]);
    expect(fila.atribucion).toEqual({ utm_source: 'facebook' });
    // El esquema lo garantiza: todas las columnas de PII aceptan NULL y el CHECK solo las exige si no está anonimizado.
    const cols = await db.sql.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns where table_schema = 'captacion' and table_name = 'leads'
       and column_name in ('nombre','nombre_pila','telefono','telefono_hmac','email','respuestas','visitor_id')`);
    expect(cols.rows.every((c) => c.is_nullable === 'YES')).toBe(true);
    await expect(db.sql.query(`update captacion.leads set anonimizado_en = null where id = $1`, [l.id])).rejects.toThrow(/leads_pii_salvo_anonimizado/);
  });
});

describe('R8 · logs de las edge functions', () => {
  it('se emite un log con teléfono → queda redactado (***)', async () => {
    const lineas: string[] = [];
    crearLogger({ funcion: 'arco' }, (x) => lineas.push(x)).info('solicitud de 81 1234 5678', { telefono: '528112345678', detalle: 'tel +52 81 1234 5678', email: 'a@b.mx' });
    expect(lineas.join()).not.toMatch(/1234|a@b\.mx/);
    expect(lineas.join()).toContain('***');
    expect(redactar({ nested: { phone: '8112345678' } })).toEqual({ nested: { phone: '***' } });
  });

  it('el handler arco no registra ni devuelve el teléfono, ni siquiera en errores', async () => {
    const lineas: string[] = [];
    const log = crearLogger({ funcion: 'arco' }, (x) => lineas.push(x));
    const privacidad: DepsPrivacidad = { repo: crearRepoPrivacidadSql(db.servicio), contactos: { telefonoDeLead: async () => null },
      clock: new FixedClock(new Date()), logger: log, pepper: PEPPER };
    const h = crearHandlerArco({ autenticar: async () => ({ tipo: 'servicio' }), privacidad, log });
    const post = (b: unknown) => h(new Request('https://x/arco', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
    const respuestas = [
      await post({ accion: 'registrar', tipo: 'acceso', canal: 'correo', telefono: '81 1234 5678' }),
      await post({ accion: 'registrar', tipo: 'acceso', canal: 'correo', telefono: '81 1234 567' }),
      await post({ accion: 'registrar', tipo: 'acceso', canal: 'correo', telefono: '81 1234 5678', extra: 'mariana@correo.mx' }),
    ];
    expect(respuestas.map((r) => r.status)).toEqual([201, 400, 400]);
    const textos = await Promise.all(respuestas.map((r) => r.text()));
    expect(lineas.join('\n') + textos.join('\n')).not.toMatch(/1234|mariana/);
  });

  it('el handler retencion-diaria solo registra conteos', async () => {
    const lineas: string[] = [];
    const log = crearLogger({ funcion: 'retencion-diaria' }, (x) => lineas.push(x));
    const v = await crearVacante(db.sql);
    await sembrarLead(v, { postulado: new Date(AHORA.getTime() - 49 * HORA) });
    const h = crearHandlerRetencion({ secreto: 's'.repeat(40), log, ejecutar: () => ejecutarRetencionDiaria({ repo: crearRepoPrivacidadSql(db.servicio), clock: new FixedClock(AHORA), logger: log }) });
    const res = await h(new Request('https://x', { method: 'POST', headers: { authorization: `Bearer ${'s'.repeat(40)}` } }));
    expect(res.status).toBe(200);
    expect(lineas.join('\n') + (await res.text())).not.toMatch(/8112345678|mariana|[0-9a-f]{64}/i);
  });
});

describe('Otras filas de la tabla de retención', () => {
  it('código OTP: se borra a las 24 h (captación y el cifrado de comunicación)', async () => {
    const v = await crearVacante(db.sql);
    const l = await sembrarLead(v, { postulado: new Date(AHORA.getTime() - 25 * HORA), verificado: new Date(AHORA.getTime() - 25 * HORA) });
    const { mensajeId } = await encolarMensaje(db.servicio, { tipo: 'otp', canal: 'whatsapp', leadId: l.id, vacanteId: v.vacanteId, clienteId: v.clienteId, llave: 'otp:1', codigoCifrado: 'v1.aaaa.bbbb' });
    await db.sql.query('update comunicacion.mensajes set creado_en = $2 where id = $1', [mensajeId, new Date(AHORA.getTime() - 25 * HORA).toISOString()]);
    const r = await retencion();
    expect(r.conteos).toMatchObject({ captacion: { otp_24h: 1 }, comunicacion: { otp_borrados: 1 } });
    expect((await db.sql.query('select 1 from captacion.otp')).rows).toHaveLength(0);
    expect((await db.sql.query<{ c: string | null }>('select codigo_cifrado as c from comunicacion.mensajes')).rows[0]!.c).toBeNull();
  });

  it('bitácora de mensajes: a los 90 días se quita el lead_id y el costo se conserva', async () => {
    const v = await crearVacante(db.sql);
    const lead = uuid();
    const { mensajeId } = await encolarMensaje(db.servicio, { tipo: 'confirmacion', canal: 'whatsapp', leadId: lead, vacanteId: v.vacanteId, clienteId: v.clienteId, llave: 'c:1', variables: { fecha: 'lunes' } });
    await db.sql.query(`update comunicacion.mensajes set creado_en = $2, estado = 'enviado', costo_mxn = 0.5 where id = $1`, [mensajeId, new Date(AHORA.getTime() - 91 * DIA).toISOString()]);
    await db.sql.query(`insert into comunicacion.intentos (mensaje_id, cliente_id, vacante_id, canal, proveedor, intento, resultado, costo_mxn) values ($1, $2, $3, 'whatsapp', 'evolution', 1, 'enviado', 0.5)`,
      [mensajeId, v.clienteId, v.vacanteId]);
    const r = await retencion();
    expect(r.conteos.comunicacion).toMatchObject({ bitacora_desligada: 1 });
    const m = (await db.sql.query<{ lead_id: string | null; costo_mxn: string }>('select lead_id, costo_mxn from comunicacion.mensajes')).rows[0]!;
    expect(m.lead_id).toBeNull();
    expect(Number(m.costo_mxn)).toBe(0.5);
    const costos = await db.servicio.query<{ costo_mxn: string }>('select costo_mxn from comunicacion.api_costos where vacante_id = $1', [v.vacanteId]);
    expect(Number(costos.rows[0]!.costo_mxn)).toBe(0.5);
  });

  it('evento de Zoho: hasta la cita + 30 días; luego se borra (el lead sigue en bloqueo)', async () => {
    const v = await crearVacante(db.sql);
    await guardarReglas(db.sql, v.vacanteId, { zoho_calendar_uid: CAL });
    const cal = new CalendarioMemoria();
    const lead31 = await sembrarLead(v, { postulado: new Date(AHORA.getTime() - 40 * DIA), verificado: new Date(AHORA.getTime() - 40 * DIA) });
    const lead29 = await sembrarLead(v, { postulado: new Date(AHORA.getTime() - 40 * DIA), verificado: new Date(AHORA.getTime() - 40 * DIA), telefono: '528119999999' });
    for (const [l, dias] of [[lead31, 31.1], [lead29, 29]] as const) {
      const inicio = new Date(AHORA.getTime() - dias * DIA);
      const c = await retener(l, inicio, new Date(inicio.getTime() - DIA), 5);
      await confirmar(l, c, new Date(inicio.getTime() - DIA + 60_000));
    }
    await zoho(cal);
    expect(cal.eventos.size).toBe(2);
    const r = await retencion();
    expect(r.conteos.citas).toMatchObject({ zoho: { zoho_evento_cita_30d: 1 } });
    await zoho(cal);
    expect(cal.eventos.size).toBe(1);
    expect((await db.sql.query<{ nombre: string }>('select nombre from captacion.leads where id = $1', [lead31.id])).rows[0]!.nombre).toBe('mariana garza');
    expect((await db.servicio.query<{ b: boolean }>('select privacidad.api_lead_bloqueado($1) as b', [lead31.id])).rows[0]!.b).toBe(true);
  });
});
