import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../test/db/harness.ts';
import { crearUsuario, crearVacante } from '../../../test/db/fixtures.ts';
import { encolarMensaje, registrarOptOut, hmacTelefono } from './index.ts';

let db: TestDb;
beforeEach(async () => {
  db = await crearTestDb();
}, 120_000);
afterEach(async () => {
  await db?.close();
});

const LEAD = '0190d3a0-0000-7000-8000-0000000000a1';
const OTRO_LEAD = '0190d3a0-0000-7000-8000-0000000000a2';
const PEPPER = 'pepper-de-prueba';

async function sembrar(vacanteId: string, clienteId: string, leadId = LEAD, llave = `confirmacion:${leadId}`) {
  return encolarMensaje(db.servicio, { tipo: 'confirmacion', canal: 'whatsapp', leadId, vacanteId, clienteId, llave, variables: { fecha: 'lunes', hora: '10:00' } });
}

describe('esquema comunicacion · RLS', () => {
  it('anon no puede leer ninguna tabla ni la vista de costos', async () => {
    for (const t of ['mensajes', 'intentos', 'opt_out', 'webhooks_vistos', 'api_costos', 'api_fallos']) {
      await expect(db.como('anon', null, (s) => s.query(`select * from comunicacion.${t} limit 1`)), t).rejects.toThrow(/permission denied/);
    }
  });

  it('el panel lee la bitácora y los costos solo de sus vacantes', async () => {
    const a = await crearVacante(db.sql, { slug: 'va' });
    const b = await crearVacante(db.sql, { slug: 'vb' });
    await sembrar(a.vacanteId, a.clienteId, LEAD);
    await sembrar(b.vacanteId, b.clienteId, OTRO_LEAD);
    await db.sql.query(`insert into comunicacion.intentos (mensaje_id, cliente_id, vacante_id, canal, proveedor, intento, resultado, costo_mxn)
      select id, cliente_id, vacante_id, canal, 'evolution', 1, 'enviado', 0.5 from comunicacion.mensajes`);
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const vis = await db.comoUsuario(reclutador, (s) => s.query<{ vacante_id: string }>('select vacante_id from comunicacion.mensajes'));
    expect(vis.rows.map((r) => r.vacante_id)).toEqual([a.vacanteId]);
    const costos = await db.comoUsuario(reclutador, (s) => s.query<{ vacante_id: string; costo_mxn: string; intentos: number }>('select * from comunicacion.api_costos'));
    expect(costos.rows).toHaveLength(1);
    expect(costos.rows[0]).toMatchObject({ vacante_id: a.vacanteId, canal: 'whatsapp', proveedor: 'evolution', intentos: 1, exitosos: 1 });
    expect(Number(costos.rows[0]!.costo_mxn)).toBe(0.5);
    await expect(db.comoUsuario(reclutador, (s) => s.query('select * from comunicacion.opt_out'))).rejects.toThrow(/permission denied/);
  });

  it('authenticated no puede ejecutar las funciones de privacidad ni escribir', async () => {
    const reclutador = await crearUsuario(db.sql, 'admin');
    await expect(db.comoUsuario(reclutador, (s) => s.query(`select comunicacion.suprimir_lead($1)`, [LEAD]))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(reclutador, (s) => s.query(`select comunicacion.retencion_aplicar(now())`))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(reclutador, (s) => s.query(`delete from comunicacion.mensajes`))).rejects.toThrow(/permission denied/);
  });

  it('la bitácora no tiene columnas de texto del mensaje ni de destino', async () => {
    const { rows } = await db.sql.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'comunicacion' and table_name in ('mensajes','intentos','opt_out')`);
    const cols = rows.map((r) => r.column_name);
    for (const prohibida of ['texto', 'contenido', 'cuerpo', 'telefono', 'email', 'nombre', 'codigo']) expect(cols).not.toContain(prohibida);
  });
});

describe('COM-04 · encolarMensaje', () => {
  it('es idempotente por llave y la cola solo lleva el id del mensaje', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const a = await sembrar(vacanteId, clienteId);
    const b = await sembrar(vacanteId, clienteId);
    expect(a.mensajeId).toBe(b.mensajeId);
    const cola = await db.sql.query<{ payload: unknown; prioridad: number }>(`select payload, prioridad from shared.cola where cola = 'comunicacion'`);
    expect(cola.rows).toEqual([{ payload: { mensaje_id: a.mensajeId }, prioridad: 2 }]);
  });

  it('el OTP se encola con prioridad 0 y solo guarda el código cifrado', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await encolarMensaje(db.servicio, { tipo: 'otp', canal: 'whatsapp', leadId: LEAD, vacanteId, clienteId, llave: 'otp:1', codigoCifrado: 'v1.aaaa.bbbb' });
    const { rows } = await db.sql.query<{ prioridad: number }>(`select prioridad from shared.cola`);
    expect(rows[0]!.prioridad).toBe(0);
    const m = await db.sql.query<{ codigo_cifrado: string }>(`select codigo_cifrado from comunicacion.mensajes`);
    expect(m.rows[0]!.codigo_cifrado).toBe('v1.aaaa.bbbb');
  });

  it('rechaza solicitudes inválidas', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await expect(encolarMensaje(db.servicio, { tipo: 'confirmacion', canal: 'whatsapp', leadId: LEAD, vacanteId, clienteId, llave: 'x', variables: { telefono: '1' } })).rejects.toThrow();
  });

  it('respeta programadoPara como visible_desde', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await encolarMensaje(db.servicio, { tipo: 'recordatorio_24h', canal: 'whatsapp', leadId: LEAD, vacanteId, clienteId, llave: 'r:1', programadoPara: '2030-01-01T15:00:00.000Z' });
    const { rows } = await db.sql.query<{ v: Date }>(`select visible_desde as v from shared.cola`);
    expect(new Date(rows[0]!.v).toISOString()).toBe('2030-01-01T15:00:00.000Z');
  });
});

describe('Privacidad', () => {
  it('suprimir_lead cancela lo pendiente, desliga la bitácora y es idempotente', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const m = await sembrar(vacanteId, clienteId, LEAD);
    await sembrar(vacanteId, clienteId, OTRO_LEAD);
    await db.sql.query(`update comunicacion.mensajes set codigo_cifrado = 'v1.a.b' where id = $1`, [m.mensajeId]);
    const r1 = await db.servicio.query<{ r: Record<string, number> }>(`select comunicacion.suprimir_lead($1) as r`, [LEAD]);
    expect(r1.rows[0]!.r).toEqual({ cancelados: 1, desligados: 1 });
    const { rows } = await db.sql.query<{ lead_id: string | null; estado: string; variables: unknown; codigo_cifrado: string | null; cita_id: string | null }>(
      `select lead_id, estado, variables, codigo_cifrado, cita_id from comunicacion.mensajes where id = $1`,
      [m.mensajeId],
    );
    expect(rows[0]).toEqual({ lead_id: null, estado: 'cancelado', variables: null, codigo_cifrado: null, cita_id: null });
    const r2 = await db.servicio.query<{ r: Record<string, number> }>(`select comunicacion.suprimir_lead($1) as r`, [LEAD]);
    expect(r2.rows[0]!.r).toEqual({ cancelados: 0, desligados: 0 });
    const otro = await db.sql.query(`select 1 from comunicacion.mensajes where lead_id = $1`, [OTRO_LEAD]);
    expect(otro.rows).toHaveLength(1);
  });

  it('retencion_aplicar: a 90 días quita lead_id y conserva costos; OTP cifrado se borra a las 24 h', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    const viejo = await sembrar(vacanteId, clienteId, LEAD, 'viejo');
    const nuevo = await sembrar(vacanteId, clienteId, OTRO_LEAD, 'nuevo');
    await encolarMensaje(db.servicio, { tipo: 'otp', canal: 'whatsapp', leadId: OTRO_LEAD, vacanteId, clienteId, llave: 'otp:x', codigoCifrado: 'v1.a.b' });
    await db.sql.query(`update comunicacion.mensajes set creado_en = '2026-01-01T00:00:00Z' where id = $1`, [viejo.mensajeId]);
    await db.sql.query(`update comunicacion.mensajes set creado_en = '2026-11-10T00:00:00Z' where llave = 'otp:x'`);
    await db.sql.query(`update comunicacion.mensajes set creado_en = '2026-11-12T00:00:00Z' where id = $1`, [nuevo.mensajeId]);
    await db.sql.query(`insert into comunicacion.intentos (mensaje_id, cliente_id, vacante_id, canal, proveedor, intento, resultado, costo_mxn, creado_en)
      values ($1, $2, $3, 'whatsapp', 'evolution', 1, 'enviado', 1.25, '2026-01-01T00:00:00Z')`, [viejo.mensajeId, clienteId, vacanteId]);
    await db.sql.query(`insert into comunicacion.webhooks_vistos (proveedor, evento_id, visto_en) values ('evolution', 'e1', '2026-01-01T00:00:00Z')`);
    const antes = await db.sql.query<{ costo: string }>(`select sum(costo_mxn) as costo from comunicacion.api_costos`);
    const r = await db.servicio.query<{ r: Record<string, number> }>(`select comunicacion.retencion_aplicar('2026-11-13T00:00:00Z') as r`);
    expect(r.rows[0]!.r).toEqual({ bitacora_desligada: 1, otp_borrados: 1, webhooks_borrados: 1 });
    const v = await db.sql.query<{ lead_id: string | null }>(`select lead_id from comunicacion.mensajes where id = $1`, [viejo.mensajeId]);
    expect(v.rows[0]!.lead_id).toBeNull();
    const n = await db.sql.query<{ lead_id: string | null }>(`select lead_id from comunicacion.mensajes where id = $1`, [nuevo.mensajeId]);
    expect(n.rows[0]!.lead_id).toBe(OTRO_LEAD);
    const despues = await db.sql.query<{ costo: string }>(`select sum(costo_mxn) as costo from comunicacion.api_costos`);
    expect(despues.rows[0]!.costo).toBe(antes.rows[0]!.costo);
    const r2 = await db.servicio.query<{ r: Record<string, number> }>(`select comunicacion.retencion_aplicar('2026-11-13T00:00:00Z') as r`);
    expect(r2.rows[0]!.r).toEqual({ bitacora_desligada: 0, otp_borrados: 0, webhooks_borrados: 0 });
  });

  it('opt-out permanente: solo guarda el HMAC del teléfono, idempotente', async () => {
    const { clienteId } = await crearVacante(db.sql);
    expect(await registrarOptOut(db.servicio, { telefonoE164: '528112345678', clienteId, origen: 'arco' }, PEPPER)).toBe(true);
    expect(await registrarOptOut(db.servicio, { telefonoE164: '+52 81 1234 5678', clienteId, origen: 'arco' }, PEPPER)).toBe(false);
    expect(await registrarOptOut(db.servicio, { telefonoHmac: await hmacTelefono(PEPPER, '525500000000'), clienteId: null, origen: 'webhook' }, PEPPER)).toBe(true);
    const { rows } = await db.sql.query<{ telefono_hmac: string }>(`select telefono_hmac from comunicacion.opt_out order by creado_en`);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.telefono_hmac).toBe(await hmacTelefono(PEPPER, '528112345678'));
    expect(JSON.stringify(rows)).not.toContain('8112345678');
  });
});
