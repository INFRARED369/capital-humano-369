/**
 * BD / seguridad de captación (sustituto de pgTAP con PGlite):
 * RLS (S1, S2), restricciones de esquema (R7), retención (R1, OTP 24 h) y supresión (R6).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearUsuario, crearVacante } from '../../../../../test/db/fixtures.ts';
import { generarFolio } from '../../domain/lead.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000);
afterEach(async () => { await db.close(); });

const HMAC = (c: string) => c.repeat(64).slice(0, 64);
let n = 0;

async function insertarLead(vacanteId: string, clienteId: string, o: { estado?: string; postuladoEn?: string; hmac?: string } = {}): Promise<string> {
  n++;
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into captacion.leads (cliente_id, vacante_id, folio, nombre, nombre_pila, telefono, telefono_hmac, email, respuestas,
       consentimiento_version, consentido_en, atribucion, visitor_id, event_id, estado, postulado_en, creado_en)
     values ($1, $2, $3, 'Ana López', 'Ana', '528112345678', $4, 'ana@x.mx', '{"edad": 20}', '2026-11-13', $5, '{"utm_source":"facebook","fbclid":"abc"}',
       'vis-1', gen_random_uuid(), $6, $5, $5) returning id`,
    [clienteId, vacanteId, generarFolio(), o.hmac ?? HMAC(String(n % 10)), o.postuladoEn ?? '2026-11-16T15:00:00Z', o.estado ?? 'pendiente_otp'],
  );
  return rows[0]!.id;
}

async function insertarOtp(leadId: string, clienteId: string, creadoEn = '2026-11-16T15:00:00Z') {
  await db.sql.query(
    `insert into captacion.otp (id, cliente_id, lead_id, codigo_hash, expira_en, creado_en) values (gen_random_uuid(), $1, $2, $3, $4::timestamptz + interval '10 minutes', $4)`,
    [clienteId, leadId, HMAC('f'), creadoEn],
  );
}

describe('esquema', () => {
  it('folio único y con formato; teléfono E.164 MX; estado válido', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await insertarLead(vacanteId, clienteId);
    await expect(db.sql.query(`update captacion.leads set folio = '369-0000'`)).rejects.toThrow();
    await expect(db.sql.query(`update captacion.leads set telefono = '8112345678'`)).rejects.toThrow();
    await expect(db.sql.query(`update captacion.leads set estado = 'descalificado'`)).rejects.toThrow();
  });

  it('un solo OTP vigente por lead y como máximo 5 intentos', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const lead = await insertarLead(vacanteId, clienteId);
    await insertarOtp(lead, clienteId);
    await expect(insertarOtp(lead, clienteId)).rejects.toThrow();
    await expect(db.sql.query(`update captacion.otp set intentos = 6`)).rejects.toThrow();
  });

  it('O5 · la tabla otp no tiene columna para el código en claro', async () => {
    const { rows } = await db.sql.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'captacion' and table_name = 'otp'`);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('codigo_hash');
    expect(cols.filter((c) => c !== 'codigo_hash' && /codigo|code|otp_plain/.test(c))).toEqual([]);
  });

  it('toda tabla de captacion tiene cliente_id not null', async () => {
    const { rows } = await db.sql.query<{ table_name: string; is_nullable: string }>(
      `select c.table_name, c.is_nullable from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
       where c.table_schema = 'captacion' and c.column_name = 'cliente_id' and t.table_type = 'BASE TABLE'`);
    const { rows: tablas } = await db.sql.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'captacion' and table_type = 'BASE TABLE'`);
    expect(rows.map((r) => r.table_name).sort()).toEqual(tablas.map((t) => t.table_name).sort());
    expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
  });
});

describe('RLS (S1, S2)', () => {
  it('anon no lee ni escribe ninguna tabla de captacion', async () => {
    for (const t of ['leads', 'otp', 'envios_limitados', 'contactos_b2b']) {
      await expect(db.como('anon', null, (s) => s.query(`select * from captacion.${t}`)), t).rejects.toThrow(/permission denied/);
    }
    await expect(db.como('anon', null, (s) => s.query(`select captacion.suprimir_lead(gen_random_uuid())`))).rejects.toThrow(/permission denied/);
  });

  it('S1 · un reclutador de A solo ve los leads de A; nadie del panel ve OTP', async () => {
    const a = await crearVacante(db.sql, { slug: 'vac-a' });
    const b = await crearVacante(db.sql, { slug: 'vac-b' });
    const la = await insertarLead(a.vacanteId, a.clienteId);
    await insertarLead(b.vacanteId, b.clienteId);
    await insertarOtp(la, a.clienteId);
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const vistos = await db.comoUsuario(reclutador, (s) => s.query<{ id: string }>('select id from captacion.leads'));
    expect(vistos.rows.map((r) => r.id)).toEqual([la]);
    await expect(db.comoUsuario(reclutador, (s) => s.query('select * from captacion.otp'))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(reclutador, (s) => s.query(`update captacion.leads set nombre = 'x'`))).rejects.toThrow(/permission denied/);
  });

  it('PII por rol: authenticated solo lee columnas sin PII; nombre/teléfono solo en api_leads_panel y solo para admin y reclutador', async () => {
    const a = await crearVacante(db.sql, { slug: 'vac-a' });
    const la = await insertarLead(a.vacanteId, a.clienteId);
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const cliente = await crearUsuario(db.sql, 'cliente', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const admin = await crearUsuario(db.sql, 'admin');
    const otro = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId });
    // La consulta del panel (apps/web/lib/panel/api.ts) sigue funcionando para todos los roles.
    for (const u of [reclutador, cliente, admin]) {
      const r = await db.comoUsuario(u, (s) => s.query<{ id: string }>('select id, folio, nombre_pila, vacante_id, estado, cita_id from captacion.leads'));
      expect(r.rows.map((x) => x.id)).toEqual([la]);
    }
    // Ningún rol del panel lee PII directo de la tabla (ni el rol cliente).
    for (const col of ['telefono', 'telefono_hmac', 'nombre', 'email', 'respuestas', 'visitor_id', 'atribucion', 'event_id', '*']) {
      await expect(db.comoUsuario(cliente, (s) => s.query(`select ${col} from captacion.leads`)), col).rejects.toThrow(/permission denied/);
      await expect(db.comoUsuario(reclutador, (s) => s.query(`select ${col} from captacion.leads`)), col).rejects.toThrow(/permission denied/);
    }
    const vista = (u: string) => db.comoUsuario(u, (s) => s.query<{ id: string; nombre: string | null; telefono: string | null; email: string | null; folio: string }>(
      'select id, folio, nombre, telefono, email from captacion.api_leads_panel'));
    expect((await vista(reclutador)).rows).toEqual([expect.objectContaining({ id: la, nombre: 'Ana López', telefono: '528112345678', email: 'ana@x.mx' })]);
    expect((await vista(admin)).rows).toEqual([expect.objectContaining({ id: la, telefono: '528112345678' })]);
    expect((await vista(cliente)).rows).toEqual([expect.objectContaining({ id: la, nombre: null, telefono: null, email: null })]);
    expect((await vista(otro)).rows).toEqual([]);
    await expect(db.como('anon', null, (s) => s.query('select * from captacion.api_leads_panel'))).rejects.toThrow(/permission denied/);
  });

  it('contactos B2B solo para admin', async () => {
    await db.sql.query(`insert into captacion.contactos_b2b (nombre, empresa, email, servicio, consentimiento_version, consentido_en) values ('Laura', 'E', 'l@e.mx', 'Solución integral', 'v', now())`);
    const admin = await crearUsuario(db.sql, 'admin');
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const rec = await crearUsuario(db.sql, 'reclutador', { clienteId, vacantes: [vacanteId] });
    expect((await db.comoUsuario(admin, (s) => s.query('select * from captacion.contactos_b2b'))).rows).toHaveLength(1);
    expect((await db.comoUsuario(rec, (s) => s.query('select * from captacion.contactos_b2b'))).rows).toHaveLength(0);
  });

  it('service_role (edge functions) opera las tablas', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await insertarLead(vacanteId, clienteId);
    const { rows } = await db.servicio.query('select * from captacion.leads');
    expect(rows).toHaveLength(1);
  });
});

describe('retención (Política de retención, R1, R2, OTP 24 h)', () => {
  it('R1/R2 · lead sin verificar de hace 49 h → supresión total (incl. HMAC) y LeadSuprimido; el verificado se conserva', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const viejo = await insertarLead(vacanteId, clienteId, { postuladoEn: '2026-11-14T13:00:00Z', hmac: HMAC('a') });
    const bloqueado = await insertarLead(vacanteId, clienteId, { postuladoEn: '2026-11-14T13:00:00Z', estado: 'otp_bloqueado' });
    const reciente = await insertarLead(vacanteId, clienteId, { postuladoEn: '2026-11-15T15:00:00Z' });
    const verificado = await insertarLead(vacanteId, clienteId, { postuladoEn: '2026-11-01T15:00:00Z', estado: 'verificado' });
    await insertarOtp(viejo, clienteId, '2026-11-16T13:00:00Z');
    await db.sql.query(`insert into captacion.envios_limitados (cliente_id, tipo, telefono_hmac, lead_id, creado_en) values ($1, 'otp', $2, $3, '2026-11-16T13:00:00Z')`, [clienteId, HMAC('a'), viejo]);

    const { rows: [r] } = await db.sql.query<{ r: Record<string, number> }>(`select captacion.retencion_aplicar('2026-11-16T14:00:00Z') as r`);
    expect(r!.r).toMatchObject({ leads_sin_verificar_48h: 2 });

    const ids = (await db.sql.query<{ id: string }>('select id from captacion.leads order by id')).rows.map((x) => x.id).sort();
    expect(ids).toEqual([reciente, verificado].sort());
    const hmacs = await db.sql.query(`select 1 from captacion.leads where telefono_hmac = $1 union all select 1 from captacion.envios_limitados where telefono_hmac = $1`, [HMAC('a')]);
    expect(hmacs.rows).toHaveLength(0);
    expect((await db.sql.query(`select * from captacion.otp where lead_id = $1`, [viejo])).rows).toHaveLength(0);

    const ev = await db.sql.query<{ payload: { lead_id: string; regla: string } }>(`select payload from shared.outbox where tipo = 'LeadSuprimido'`);
    expect(ev.rows.map((e) => e.payload.lead_id).sort()).toEqual([viejo, bloqueado].sort());
    expect(JSON.stringify(ev.rows)).not.toMatch(/528112345678|Ana/);

    // idempotente
    const { rows: [r2] } = await db.sql.query<{ r: Record<string, number> }>(`select captacion.retencion_aplicar('2026-11-16T14:00:00Z') as r`);
    expect(r2!.r).toMatchObject({ leads_sin_verificar_48h: 0 });
  });

  it('OTP y registros de rate limit se borran a las 24 h', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const lead = await insertarLead(vacanteId, clienteId, { estado: 'verificado' });
    await insertarOtp(lead, clienteId, '2026-11-15T13:59:00Z');
    await db.sql.query(`update captacion.otp set estado = 'verificado'`);
    await insertarOtp(lead, clienteId, '2026-11-16T13:00:00Z');
    await db.sql.query(`insert into captacion.envios_limitados (cliente_id, tipo, ip_hmac, creado_en) values ($1, 'otp', $2, '2026-11-15T13:00:00Z'), ($1, 'otp', $2, '2026-11-16T13:00:00Z')`, [clienteId, HMAC('b')]);
    const { rows: [r] } = await db.sql.query<{ r: Record<string, number> }>(`select captacion.retencion_aplicar('2026-11-16T14:00:00Z') as r`);
    expect(r!.r).toMatchObject({ otp_24h: 1, envios_24h: 1 });
    expect((await db.sql.query('select * from captacion.otp')).rows).toHaveLength(1);
    expect((await db.sql.query('select * from captacion.envios_limitados')).rows).toHaveLength(1);
  });

  it('contactos B2B se anonimizan a los 180 días', async () => {
    await db.sql.query(`insert into captacion.contactos_b2b (nombre, empresa, email, servicio, mensaje, consentimiento_version, consentido_en, creado_en)
      values ('Laura', 'E', 'l@e.mx', 'Solución integral', 'hola', 'v', '2026-05-01', '2026-05-01'), ('Mario', 'F', 'm@f.mx', 'Solución integral', null, 'v', '2026-11-01', '2026-11-01')`);
    const { rows: [r] } = await db.sql.query<{ r: Record<string, number> }>(`select captacion.retencion_aplicar('2026-11-16T14:00:00Z') as r`);
    expect(r!.r).toMatchObject({ contactos_b2b_180d: 1 });
    const { rows } = await db.sql.query<{ nombre: string | null; email: string | null; mensaje: string | null; servicio: string }>(`select * from captacion.contactos_b2b order by creado_en`);
    expect(rows[0]).toMatchObject({ nombre: null, email: null, mensaje: null, servicio: 'Solución integral' });
    expect(rows[1]!.nombre).toBe('Mario');
  });
});

describe('supresión y anonimización (R6, R7)', () => {
  it('R6 · suprimir_lead borra lead, OTP y rate limit del teléfono; es idempotente', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const lead = await insertarLead(vacanteId, clienteId, { hmac: HMAC('c') });
    await insertarOtp(lead, clienteId);
    await db.sql.query(`insert into captacion.envios_limitados (cliente_id, tipo, telefono_hmac, creado_en) values ($1, 'otp', $2, now())`, [clienteId, HMAC('c')]);
    const { rows: [r] } = await db.sql.query<{ r: Record<string, number> }>(`select captacion.suprimir_lead($1) as r`, [lead]);
    expect(r!.r).toEqual({ leads: 1, otp: 1, envios: 1 });
    const { rows: [r2] } = await db.sql.query<{ r: Record<string, number> }>(`select captacion.suprimir_lead($1) as r`, [lead]);
    expect(r2!.r).toEqual({ leads: 0, otp: 0, envios: 0 });
  });

  it('R7 · lead anonimizado: nombre, teléfono, email, HMAC y respuestas en NULL; quedan vacante, fechas y estado', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const lead = await insertarLead(vacanteId, clienteId, { estado: 'verificado' });
    await insertarOtp(lead, clienteId);
    await db.servicio.query(`select captacion.anonimizar_lead($1)`, [lead]);
    const { rows: [l] } = await db.sql.query<Record<string, unknown>>(`select * from captacion.leads where id = $1`, [lead]);
    expect(l).toMatchObject({ nombre: null, nombre_pila: null, telefono: null, telefono_hmac: null, email: null, respuestas: null, visitor_id: null, vacante_id: vacanteId, estado: 'verificado' });
    expect(l!.anonimizado_en).not.toBeNull();
    expect(l!.creado_en).not.toBeNull();
    expect(l!.atribucion).toEqual({ utm_source: 'facebook' });
    expect((await db.sql.query(`select * from captacion.otp where lead_id = $1`, [lead])).rows).toHaveLength(0);
  });

  it('R7 · prueba de esquema: un lead no anonimizado no puede quedar sin PII mínima', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await insertarLead(vacanteId, clienteId);
    await expect(db.sql.query(`update captacion.leads set telefono = null`)).rejects.toThrow();
  });
});
