/**
 * Schema privacidad (PGlite): orquestador retencion_diaria (PRV-01), registro sin PII (PRV-03),
 * ciclo de vida con bloqueo de 30 días (Política §1.2), permisos y RLS.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante } from '@test/db/fixtures';
import { calcularPlazos, ETAPAS } from '../../domain/ciclo-vida.ts';
import { DOMINIOS_RETENCION } from '../../domain/registro.ts';
import { crearRepoPrivacidadSql } from './repo.ts';

/** JSON devuelto por las funciones SQL (forma dinámica, se inspecciona con expect). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000);
afterEach(async () => { await db?.close(); });

const DIA = 86_400_000;
const uuid = () => globalThis.crypto.randomUUID();
const diaria = async (ahora: Date | string, sql = db.servicio) =>
  (await sql.query<{ r: Json }>('select privacidad.retencion_diaria($1::timestamptz) as r', [new Date(ahora).toISOString()])).rows[0]!.r;
const registros = async () =>
  (await db.sql.query<Json>('select * from privacidad.registro_supresiones order by id')).rows;
const publicar = (tipo: string, payload: Record<string, unknown>, clienteId: string, creado?: Date) =>
  db.sql.query(`insert into shared.outbox (tipo, payload, cliente_id, creado_en) values ($1, $2::jsonb, $3, coalesce($4::timestamptz, now()))`,
    [tipo, JSON.stringify(payload), clienteId, creado?.toISOString() ?? null]);

describe('esquema y permisos', () => {
  it('todas las tablas de privacidad tienen RLS y anon no ve nada', async () => {
    const { rows } = await db.sql.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'privacidad' and c.relkind = 'r'`);
    expect(rows.map((r) => r.relname).sort()).toEqual(['barridos', 'ciclo_vida', 'registro_supresiones', 'solicitudes_arco']);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    for (const t of rows) {
      await expect(db.como('anon', null, (s) => s.query(`select * from privacidad.${t.relname}`)), t.relname).rejects.toThrow(/permission denied/);
    }
  });

  it('solo service_role ejecuta las funciones de supresión y retención (de todos los dominios)', async () => {
    const admin = await crearUsuario(db.sql, 'admin');
    const fns = ['privacidad.retencion_diaria(timestamptz,int)', 'privacidad.suprimir_lead(uuid)', 'privacidad.suprimir_lead(uuid,text)',
      'privacidad.retencion_aplicar(timestamptz)', 'privacidad.arco_ejecutar(uuid,timestamptz)',
      'captacion.suprimir_lead(uuid)', 'captacion.retencion_aplicar(timestamptz)', 'citas.suprimir_lead(uuid)', 'citas.retencion_aplicar(timestamptz)',
      'comunicacion.suprimir_lead(uuid)', 'comunicacion.retencion_aplicar(timestamptz)', 'tracking.suprimir_lead(uuid)', 'tracking.retencion_aplicar(timestamptz)',
      'dashboard.suprimir_lead(uuid)', 'dashboard.retencion_aplicar(timestamptz)', 'shared.suprimir_lead(uuid)', 'shared.retencion_aplicar(timestamptz)'];
    for (const f of fns) {
      const { rows } = await db.sql.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc`, [f]);
      expect(rows[0], f).toEqual({ anon: false, auth: false, svc: true });
    }
    await expect(db.comoUsuario(admin, (s) => s.query(`select privacidad.suprimir_lead($1)`, [uuid()]))).rejects.toThrow(/permission denied/);
  });

  it('solicitudes ARCO y registro: el admin lee, el reclutador no ve filas', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const admin = await crearUsuario(db.sql, 'admin');
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId, vacantes: [vacanteId] });
    await db.servicio.query(`select privacidad.arco_registrar('acceso', 'correo', $1, '{}'::uuid[], now(), current_date + 30, current_date + 50, $2)`, ['a'.repeat(64), admin]);
    await diaria(new Date());
    expect((await db.comoUsuario(admin, (s) => s.query('select * from privacidad.solicitudes_arco'))).rows).toHaveLength(1);
    expect((await db.comoUsuario(admin, (s) => s.query('select * from privacidad.registro_supresiones'))).rows).toHaveLength(1);
    expect((await db.comoUsuario(reclutador, (s) => s.query('select * from privacidad.solicitudes_arco'))).rows).toHaveLength(0);
    expect((await db.comoUsuario(reclutador, (s) => s.query('select * from privacidad.registro_supresiones'))).rows).toHaveLength(0);
    await expect(db.comoUsuario(admin, (s) => s.query(`update privacidad.solicitudes_arco set estado = 'ejecutada'`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(admin, (s) => s.query('select * from privacidad.ciclo_vida'))).rejects.toThrow(/permission denied/);
  });
});

describe('PRV-03 · registro_supresiones sin datos personales', () => {
  it('el CHECK rechaza conteos con texto, arreglos o llaves que no son identificadores', async () => {
    const ins = (conteos: unknown, reglas = '{}', errores: unknown = {}) => db.sql.query(
      `insert into privacidad.registro_supresiones (tipo, ejecutado_en, reglas, conteos, errores) values ('retencion', now(), $1::text[], $2::jsonb, $3::jsonb)`,
      [reglas, JSON.stringify(conteos), JSON.stringify(errores)]);
    await expect(ins({ telefono: '528112345678' })).rejects.toThrow(/check/i);
    await expect(ins({ ids: [1, 2] })).rejects.toThrow(/check/i);
    await expect(ins({ 'mariana@correo.mx': 1 })).rejects.toThrow(/check/i);
    await expect(ins({ a: -1 })).rejects.toThrow(/check/i);
    await expect(ins({}, '{"borré a Mariana"}')).rejects.toThrow(/check/i);
    await expect(ins({}, '{}', { captacion: 'duplicate key (telefono)=(528112345678)' })).rejects.toThrow(/check/i);
    await expect(ins({ captacion: { leads: 1, zoho: { x: 2 } } }, '{captacion.retencion_aplicar}', { citas: '23505' })).resolves.toBeDefined();
  });

  it('autolimpieza: se borra a los 2 años', async () => {
    await db.sql.query(`insert into privacidad.registro_supresiones (tipo, ejecutado_en) values ('retencion', now() - interval '2 years 1 day'), ('retencion', now() - interval '700 days')`);
    const r = await diaria(new Date());
    expect(r.conteos.privacidad.registro_2_anios).toBe(1);
    expect((await registros()).map((x) => new Date(x.ejecutado_en).getTime() > Date.now() - 800 * DIA)).toEqual([true, true]);
  });
});

describe('PRV-01 · retencion_diaria (orquestador)', () => {
  it('llama a los 6 dominios (incluidos dashboard y el kernel shared) en orden, registra solo conteos y es idempotente', async () => {
    const r1 = await diaria(new Date());
    expect(r1.dominios).toEqual(['captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'shared']);
    expect(r1.dominios).toEqual([...DOMINIOS_RETENCION]); // paridad TS ↔ SQL
    expect(r1.faltantes).toEqual([]);
    expect(r1.errores).toEqual({});
    expect(Object.keys(r1.conteos)).toEqual(expect.arrayContaining(['captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'shared', 'privacidad']));
    expect(r1.conteos.citas).toHaveProperty('zoho');
    const [reg] = await registros();
    expect(reg).toMatchObject({ tipo: 'retencion', faltantes: [], errores: {} });
    expect(reg!.reglas).toEqual(expect.arrayContaining(['captacion.retencion_aplicar', 'citas.retencion_aplicar', 'comunicacion.retencion_aplicar',
      'tracking.retencion_aplicar', 'dashboard.retencion_aplicar', 'shared.retencion_aplicar', 'privacidad.ciclo_vida', 'privacidad.retencion_aplicar']));
    // segunda corrida: nada que hacer (salvo las particiones ya creadas)
    const r2 = await diaria(new Date());
    expect(r2.total).toBe(0);
    expect(await registros()).toHaveLength(2);
  });

  it('detecta con to_regprocedure los dominios sin retencion_aplicar y los reporta como faltantes', async () => {
    await db.sql.query('drop function tracking.retencion_aplicar(timestamptz)');
    const r = await diaria(new Date());
    expect(r.faltantes).toEqual(['tracking']);
    expect(r.dominios).toEqual(['captacion', 'citas', 'comunicacion', 'dashboard', 'shared']);
    expect((await registros())[0]!.faltantes).toEqual(['tracking']);
  });

  it('una falla en un dominio no detiene a los demás y solo se guarda el SQLSTATE (sin el mensaje, que podría llevar datos)', async () => {
    await db.sql.query(`create or replace function citas.retencion_aplicar(p_ahora timestamptz) returns jsonb language plpgsql as $$
      begin raise exception 'falló con 528112345678' using errcode = 'P0001'; end $$`);
    const r = await diaria(new Date());
    expect(r.errores).toEqual({ citas: 'P0001' });
    expect(r.dominios).toEqual(['captacion', 'comunicacion', 'tracking', 'dashboard', 'shared']);
    expect(JSON.stringify(await registros())).not.toContain('528112345678');
  });

  it('procesa por lotes hasta vaciar (varias llamadas al mismo dominio) con tope', async () => {
    await db.pg.exec(`create table public.llamadas (n int); insert into public.llamadas values (0);
      create or replace function comunicacion.retencion_aplicar(p_ahora timestamptz) returns jsonb language plpgsql as $$
      declare v int; begin update public.llamadas set n = n + 1 returning n into v;
        return jsonb_build_object('lote', case when v <= 3 then 5000 else 0 end, 'texto', 'ignorado'); end $$`);
    const r = await diaria(new Date());
    expect(r.conteos.comunicacion).toEqual({ lote: 15000 });
    expect(r.lotes.comunicacion).toBe(4);
    await db.sql.query(`create or replace function comunicacion.retencion_aplicar(p_ahora timestamptz) returns jsonb language sql as $$ select '{"x":1}'::jsonb $$`);
    const tope = await db.servicio.query<{ r: Json }>(`select privacidad.retencion_diaria(now(), 3) as r`);
    expect(tope.rows[0]!.r.lotes.comunicacion).toBe(3);
  });
});

describe('ciclo de vida y bloqueo de 30 días (Política §1.2)', () => {
  it('plazos_ciclo (SQL) coincide con calcularPlazos (TS) en todas las etapas', async () => {
    const ref = new Date('2026-09-01T16:00:00Z');
    for (const etapa of ETAPAS) {
      const { rows } = await db.sql.query<{ fin_activo: Date; fin_bloqueo: Date; accion: string }>(`select * from privacidad.plazos_ciclo($1, $2)`, [etapa, ref.toISOString()]);
      const ts = calcularPlazos(etapa, ref);
      expect(new Date(rows[0]!.fin_activo).getTime(), etapa).toBe(ts.finActivo.getTime());
      expect(new Date(rows[0]!.fin_bloqueo).getTime(), etapa).toBe(ts.finBloqueo.getTime());
      expect(rows[0]!.accion).toBe(ts.accion);
    }
  });

  it('deriva la etapa de los eventos del outbox, bloquea al vencer el plazo activo y expone api_lead_bloqueado', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const lead = uuid();
    const cita = uuid();
    const inicio = new Date(Date.now() - 40 * DIA);
    await publicar('LeadCreado', { lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, folio: '369-ABCDEF', event_id: uuid(), visitor_id: null, origen: null }, clienteId);
    await publicar('WhatsAppVerificado', { lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, event_id: uuid() }, clienteId);
    await publicar('CitaConfirmada', { cita_id: cita, lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, inicio: inicio.toISOString(), fin: inicio.toISOString(),
      folio: '369-ABCDEF', nombre_pila: 'Mariana', reglas_version: 1, event_id: uuid() }, clienteId);
    await publicar('AsistenciaRegistrada', { cita_id: cita, lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, asistio: false, event_id: uuid() }, clienteId);

    const r = await diaria(new Date());
    expect(r.conteos.privacidad).toMatchObject({ outbox_eventos: 4, ciclo_bloqueados: 1, ciclo_anonimizados: 0 });
    const { rows } = await db.sql.query<Json>('select etapa, cita_id, referencia, bloqueado_en from privacidad.ciclo_vida where lead_id = $1', [lead]);
    expect(rows[0]).toMatchObject({ etapa: 'no_asistio', cita_id: cita });
    expect(new Date(rows[0]!.referencia).getTime()).toBe(inicio.getTime());
    expect(rows[0]!.bloqueado_en).not.toBeNull();

    // el panel puede preguntar si un lead está bloqueado (sin ver la tabla)
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId, vacantes: [vacanteId] });
    const b = await db.comoUsuario(reclutador, (s) => s.query<{ b: boolean }>('select privacidad.api_lead_bloqueado($1) as b', [lead]));
    expect(b.rows[0]!.b).toBe(true);
    const otro = await db.comoUsuario(reclutador, (s) => s.query<{ b: boolean }>('select privacidad.api_lead_bloqueado($1) as b', [uuid()]));
    expect(otro.rows[0]!.b).toBe(false);
  });

  it('LeadContratado: etapa contratado (máx. 30 días) y, con la entrega, bloqueo inmediato de 30 días', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const lead = uuid();
    const cita = uuid();
    const contratado = new Date(Date.now() - 10 * DIA);
    const entregado = new Date(Date.now() - 2 * DIA);
    await publicar('AsistenciaRegistrada', { cita_id: cita, lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, asistio: true, event_id: uuid() }, clienteId, new Date(Date.now() - 20 * DIA));
    await publicar('LeadContratado', { lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, cita_id: cita, entregado_en: null, event_id: uuid() }, clienteId, contratado);
    await diaria(new Date(Date.now() - 9 * DIA));
    let fila = (await db.sql.query<Json>('select etapa, referencia, fin_activo, fin_bloqueo, bloqueado_en from privacidad.ciclo_vida where lead_id = $1', [lead])).rows[0]!;
    expect(fila.etapa).toBe('contratado');
    expect(new Date(fila.referencia).getTime()).toBe(contratado.getTime());
    expect(new Date(fila.fin_activo).getTime()).toBe(contratado.getTime() + 30 * DIA);
    expect(fila.bloqueado_en).toBeNull();

    await publicar('LeadContratado', { lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, cita_id: cita, entregado_en: entregado.toISOString(), event_id: uuid() }, clienteId, entregado);
    const r = await diaria(new Date());
    expect(r.conteos.privacidad).toMatchObject({ ciclo_bloqueados: 1, ciclo_anonimizados: 0 });
    fila = (await db.sql.query<Json>('select etapa, referencia, fin_activo, fin_bloqueo, bloqueado_en from privacidad.ciclo_vida where lead_id = $1', [lead])).rows[0]!;
    expect(fila.etapa).toBe('entregado');
    expect(new Date(fila.fin_activo).getTime()).toBe(entregado.getTime());
    expect(new Date(fila.fin_bloqueo).getTime()).toBe(entregado.getTime() + 30 * DIA);
    expect(fila.bloqueado_en).not.toBeNull();
  });

  it('LeadSuprimido borra el ciclo y deja un barrido temporal que se limpia solo', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const lead = uuid();
    await publicar('LeadCreado', { lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, folio: '369-ABCDEF', event_id: uuid(), visitor_id: null, origen: null }, clienteId);
    await publicar('LeadSuprimido', { lead_id: lead, vacante_id: vacanteId, cliente_id: clienteId, regla: 'lead_sin_verificar_48h' }, clienteId);
    const r = await diaria(new Date());
    expect(r.conteos.privacidad).toMatchObject({ outbox_suprimidos: 1 });
    expect((await db.sql.query('select 1 from privacidad.ciclo_vida')).rows).toHaveLength(0);
    expect((await db.sql.query('select 1 from privacidad.barridos where lead_id = $1', [lead])).rows).toHaveLength(1);
    await diaria(new Date(Date.now() + 4 * DIA));
    expect((await db.sql.query('select 1 from privacidad.barridos')).rows).toHaveLength(0);
  });
});

describe('repositorio SQL (crearRepoPrivacidadSql)', () => {
  const nueva = (o: Partial<Parameters<ReturnType<typeof crearRepoPrivacidadSql>['registrarSolicitud']>[0]> = {}) => ({
    tipo: 'acceso' as const, canal: 'correo' as const, telefonoHmac: 'c'.repeat(64), leads: [], recibidaEn: new Date('2026-11-17T18:00:00Z'),
    limiteRespuesta: '2026-12-15', limiteEjecucion: '2027-01-07', creadoPor: null, ...o,
  });

  it('registra, consulta y lista sin exponer el HMAC; responde una vez', async () => {
    const repo = crearRepoPrivacidadSql(db.servicio);
    const id = await repo.registrarSolicitud(nueva());
    const s = await repo.obtenerSolicitud(id);
    expect(s).toMatchObject({ id, tipo: 'acceso', estado: 'recibida', limiteRespuesta: '2026-12-15', limiteEjecucion: '2027-01-07', leads: 0, cerradaEn: null });
    expect(JSON.stringify(s)).not.toContain('c'.repeat(64));
    expect(await repo.obtenerSolicitud(uuid())).toBeNull();
    expect((await repo.listarSolicitudes({ estado: 'recibida', limite: 10 })).map((x) => x.id)).toEqual([id]);
    expect(await repo.listarSolicitudes({ estado: 'ejecutada', limite: 10 })).toEqual([]);
    expect(await repo.responderSolicitud(id, 'respondida', 'datos_entregados', new Date())).toEqual({ ok: true, value: undefined });
    expect(await repo.responderSolicitud(id, 'rechazada', 'x', new Date())).toEqual({ ok: false, error: 'TRANSICION_INVALIDA' });
    expect(await repo.responderSolicitud(uuid(), 'rechazada', 'x', new Date())).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    expect((await repo.obtenerSolicitud(id))!.cerradaEn).not.toBeNull();
  });

  it('ejecutar: acceso no es ejecutable; inexistente; errores desconocidos se propagan', async () => {
    const repo = crearRepoPrivacidadSql(db.servicio);
    const id = await repo.registrarSolicitud(nueva());
    expect(await repo.ejecutarSolicitud(id, new Date())).toEqual({ ok: false, error: 'TIPO_NO_EJECUTABLE' });
    expect(await repo.ejecutarSolicitud(uuid(), new Date())).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    await expect(repo.ejecutarSolicitud('no-uuid', new Date())).rejects.toThrow();
  });

  it('retencionDiaria: si otra corrida tiene el candado, se omite', async () => {
    await db.sql.query(`create or replace function privacidad.retencion_diaria(p_ahora timestamptz default now(), p_max_lotes int default 20) returns jsonb language sql as $$ select '{"omitida": true}'::jsonb $$`);
    expect(await crearRepoPrivacidadSql(db.servicio).retencionDiaria(new Date())).toMatchObject({ omitida: true, registroId: null });
  });

  it('la solicitud cerrada purga HMAC y leads a los 30 días y se borra a los 2 años', async () => {
    const repo = crearRepoPrivacidadSql(db.servicio);
    const id = await repo.registrarSolicitud(nueva({ leads: [uuid()] }));
    await repo.responderSolicitud(id, 'respondida', 'ok', new Date());
    await diaria(new Date(Date.now() + 31 * DIA));
    const f = (await db.sql.query<Json>('select telefono_hmac, leads, datos_purgados_en from privacidad.solicitudes_arco where id = $1', [id])).rows[0]!;
    expect(f).toMatchObject({ telefono_hmac: null, leads: [] });
    await diaria(new Date(Date.now() + 731 * DIA));
    expect((await db.sql.query('select 1 from privacidad.solicitudes_arco')).rows).toHaveLength(0);
  });
});
