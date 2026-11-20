/**
 * NFR-OBS-01 · shared.evaluar_alertas (PGlite con TODAS las migraciones).
 * Detecta: cola atascada, dead letters nuevas, tasa de fallas de OTP, alertas de Zoho no notificadas y
 * retención diaria con errores o sin correr en 26 h. Deduplica por `clave`; solo admin lee shared.alertas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearUsuario, crearVacante } from '../../../../test/db/fixtures.ts';

const AHORA = '2026-11-17T18:00:00Z';
let db: TestDb;
let vac: { vacanteId: string; clienteId: string };

beforeEach(async () => {
  db = await crearTestDb();
  vac = await crearVacante(db.sql);
  // Retención sana por defecto (corrió hace 2 h sin errores) para aislar cada regla.
  await retencion('2026-11-17T16:00:00Z');
}, 120_000);
afterEach(async () => { await db.close(); });

async function retencion(ejecutado: string, errores: Record<string, string> = {}) {
  await db.sql.query(`insert into privacidad.registro_supresiones (tipo, ejecutado_en, errores) values ('retencion', $1, $2::jsonb)`, [ejecutado, JSON.stringify(errores)]);
}
async function evaluar(ahora = AHORA, config: Record<string, unknown> = {}) {
  const { rows } = await db.servicio.query<{ r: { nuevas: number; tipos: string[] } }>(`select shared.evaluar_alertas($1::timestamptz, $2::jsonb) as r`, [ahora, JSON.stringify(config)]);
  return rows[0]!.r;
}
async function alertas() {
  const { rows } = await db.sql.query<{ tipo: string; severidad: string; clave: string; detalle: Record<string, unknown> }>(`select tipo, severidad, clave, detalle from shared.alertas order by id`);
  return rows;
}
async function encolar(cola: string, llave: string, visibleDesde: string, estado = 'pendiente') {
  await db.sql.query(`insert into shared.cola (cola, payload, llave_idempotencia, visible_desde, estado, actualizado_en) values ($1, '{}', $2, $3, $4, $3)`, [cola, llave, visibleDesde, estado]);
}
async function lead(): Promise<string> {
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into captacion.leads (cliente_id, vacante_id, folio, consentimiento_version, consentido_en, event_id, anonimizado_en)
     values ($1, $2, '369-' || upper(substr(translate(md5(random()::text), '01io', 'abcd'), 1, 6)), '2026-11-13', now(), gen_random_uuid(), now()) returning id`,
    [vac.clienteId, vac.vacanteId]);
  return rows[0]!.id;
}
async function otp(estado: string, creado: string) {
  const l = await lead();
  await db.sql.query(`insert into captacion.otp (id, cliente_id, lead_id, codigo_hash, expira_en, estado, creado_en) values (gen_random_uuid(), $1, $2, repeat('a', 64), $3::timestamptz + interval '10 minutes', $4, $3)`,
    [vac.clienteId, l, creado, estado]);
}

describe('sin problemas', () => {
  it('no genera alertas', async () => {
    expect(await evaluar()).toMatchObject({ nuevas: 0 });
    expect(await alertas()).toEqual([]);
  });
});

describe('cola atascada', () => {
  it('pendiente visible hace > 5 min o en_proceso sin avanzar > 5 min → 1 alerta por cola; dedupe en la misma hora', async () => {
    await encolar('comunicacion', 'a', '2026-11-17T17:50:00Z');
    await encolar('comunicacion', 'b', '2026-11-17T17:51:00Z', 'en_proceso');
    await encolar('comunicacion', 'c', '2026-11-17T17:58:00Z'); // reciente: no cuenta
    await encolar('zoho-sync', 'z', '2026-11-17T19:00:00Z');     // programado a futuro: no cuenta
    expect(await evaluar()).toMatchObject({ nuevas: 1 });
    expect(await alertas()).toEqual([
      { tipo: 'cola_atascada', severidad: 'critica', clave: 'cola_atascada:comunicacion:2026-11-17T18', detalle: { cola: 'comunicacion', atascados: 2, minutos: 5 } },
    ]);
    expect(await evaluar('2026-11-17T18:05:00Z')).toMatchObject({ nuevas: 0 });
    expect(await evaluar('2026-11-17T19:01:00Z')).toMatchObject({ nuevas: 1 }); // sigue atascada una hora después → se repite
  });

  it('el umbral de minutos es configurable', async () => {
    await encolar('tracking-capi', 't', '2026-11-17T17:57:00Z');
    expect(await evaluar(AHORA, { cola_atascada_min: 2 })).toMatchObject({ nuevas: 1 });
  });
});

describe('dead letters nuevas', () => {
  it('alerta por cola con el conteo desde la última alerta; las ya notificadas no se repiten', async () => {
    const dl = (cola: string) => db.sql.query(`insert into shared.dead_letter (cola_id, cola, payload, motivo, creado_en) values (1, $1, '{"mensaje_id":"x"}', 'HTTP_400 8112345678', $2)`, [cola, '2026-11-17T17:59:00Z']);
    await dl('comunicacion');
    await dl('comunicacion');
    await dl('zoho-sync');
    await evaluar();
    const a = await alertas();
    expect(a.map((x) => [x.tipo, x.detalle.cola, x.detalle.nuevas])).toEqual([['dead_letter', 'comunicacion', 2], ['dead_letter', 'zoho-sync', 1]]);
    expect(JSON.stringify(a)).not.toContain('8112345678'); // sin motivos ni payload (posible PII)
    expect(await evaluar()).toMatchObject({ nuevas: 0 });
    await dl('comunicacion');
    await evaluar();
    expect((await alertas()).at(-1)).toMatchObject({ tipo: 'dead_letter', detalle: { cola: 'comunicacion', nuevas: 1 } });
  });
});

describe('tasa de fallas de OTP (última hora)', () => {
  it('bloqueados + envíos OTP fallidos / emitidos > 15 % con muestra mínima → alerta', async () => {
    for (let i = 0; i < 8; i++) await otp('verificado', '2026-11-17T17:30:00Z');
    await otp('bloqueado', '2026-11-17T17:31:00Z');
    await otp('bloqueado', '2026-11-17T17:32:00Z');
    await otp('bloqueado', '2026-11-17T16:00:00Z'); // fuera de la ventana
    await evaluar();
    expect(await alertas()).toEqual([
      { tipo: 'otp_tasa_fallas', severidad: 'critica', clave: 'otp_tasa_fallas:2026-11-17T18', detalle: { emitidos: 10, bloqueados: 2, envios_fallidos: 0, tasa: 0.2, umbral: 0.15 } },
    ]);
  });

  it('muestra menor al mínimo o tasa bajo el umbral → sin alerta', async () => {
    await otp('bloqueado', '2026-11-17T17:31:00Z');
    expect(await evaluar()).toMatchObject({ nuevas: 0 });
    for (let i = 0; i < 12; i++) await otp('verificado', '2026-11-17T17:30:00Z');
    expect(await evaluar()).toMatchObject({ nuevas: 0 });
  });
});

describe('alertas de Zoho no notificadas', () => {
  it('ZOHO_DRIFT / DEAD_LETTER / AUTH / CONFIG_INCOMPLETA → una alerta por tipo con el conteo; las demás se ignoran; sin ids de cita', async () => {
    const z = (tipo: string) => db.sql.query(`insert into citas.zoho_alertas (cliente_id, vacante_id, cita_id, tipo, detalle) values ($1, $2, gen_random_uuid(), $3, '{"error":"x"}')`, [vac.clienteId, vac.vacanteId, tipo]);
    await z('ZOHO_DRIFT');
    await z('ZOHO_DRIFT');
    await z('ZOHO_AUTH');
    await z('ZOHO_SIN_REGISTRO');
    await evaluar();
    const a = await alertas();
    expect(a.map((x) => [x.tipo, x.severidad, x.detalle.zoho_tipo, x.detalle.nuevas])).toEqual([
      ['zoho', 'critica', 'ZOHO_AUTH', 1],
      ['zoho', 'aviso', 'ZOHO_DRIFT', 2],
    ]);
    expect(JSON.stringify(a)).not.toMatch(/cita_id|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(await evaluar()).toMatchObject({ nuevas: 0 });
    await z('ZOHO_CONFIG_INCOMPLETA');
    await z('ZOHO_DEAD_LETTER');
    await evaluar();
    expect((await alertas()).slice(2).map((x) => x.detalle.zoho_tipo).sort()).toEqual(['ZOHO_CONFIG_INCOMPLETA', 'ZOHO_DEAD_LETTER']);
  });
});

describe('retención diaria', () => {
  it('la última corrida tuvo errores → alerta (una por corrida)', async () => {
    await retencion('2026-11-17T17:00:00Z', { tracking: '42P01' });
    await evaluar();
    expect(await alertas()).toEqual([
      expect.objectContaining({ tipo: 'retencion_errores', severidad: 'critica', detalle: { errores: ['tracking'], ejecutado_en: '2026-11-17T17:00:00+00:00' } }),
    ]);
    expect(await evaluar()).toMatchObject({ nuevas: 0 });
  });

  it('sin correr en 26 h → alerta diaria', async () => {
    expect(await evaluar('2026-11-18T18:01:00Z')).toMatchObject({ nuevas: 1 });
    expect((await alertas())[0]).toMatchObject({ tipo: 'retencion_sin_correr', clave: 'retencion_sin_correr:2026-11-18' });
    expect(await evaluar('2026-11-18T19:00:00Z')).toMatchObject({ nuevas: 0 });
  });
});

describe('notificación y permisos', () => {
  it('pendientes → marcar notificada / fallo (reintenta hasta 5 veces)', async () => {
    await retencion('2026-11-17T17:00:00Z', { citas: '40001' });
    await evaluar();
    const pend = await db.servicio.query<{ id: string }>(`select id::text as id from shared.alertas_pendientes(10)`);
    expect(pend.rows).toHaveLength(1);
    const id = pend.rows[0]!.id;
    for (let i = 0; i < 5; i++) await db.servicio.query(`select shared.alertas_marcar(array[$1::bigint], false, 'webhook: HTTP 500')`, [id]);
    expect((await db.servicio.query(`select 1 from shared.alertas_pendientes(10)`)).rows).toHaveLength(0);
    await evaluar('2026-11-17T18:01:00Z', {});
    await db.sql.query(`update shared.alertas set intentos_notificacion = 0`);
    await db.servicio.query(`select shared.alertas_marcar(array[$1::bigint], true, 'webhook')`, [id]);
    const { rows } = await db.sql.query<{ notificada: boolean; canales: string }>(`select notificada_en is not null as notificada, canales from shared.alertas`);
    expect(rows).toEqual([{ notificada: true, canales: 'webhook' }]);
    expect((await db.servicio.query(`select 1 from shared.alertas_pendientes(10)`)).rows).toHaveLength(0);
  });

  it('RLS: solo admin lee shared.alertas; anon y authenticated no ejecutan las funciones', async () => {
    await retencion('2026-11-17T17:00:00Z', { citas: '40001' });
    await evaluar();
    const admin = await crearUsuario(db.sql, 'admin');
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId: vac.clienteId, vacantes: [vac.vacanteId] });
    expect((await db.comoUsuario(admin, (s) => s.query(`select * from shared.alertas`))).rows).toHaveLength(1);
    expect((await db.comoUsuario(reclutador, (s) => s.query(`select * from shared.alertas`))).rows).toHaveLength(0);
    await expect(db.como('anon', null, (s) => s.query(`select * from shared.alertas`))).rejects.toThrow(/permission denied/);
    for (const f of [`shared.evaluar_alertas(now(), '{}')`, 'shared.alertas_pendientes(1)', `shared.alertas_marcar(array[1::bigint], true, 'x')`]) {
      await expect(db.comoUsuario(admin, (s) => s.query(`select ${f}`)), f).rejects.toThrow(/permission denied/);
      await expect(db.como('anon', null, (s) => s.query(`select ${f}`)), f).rejects.toThrow(/permission denied/);
    }
  });
});
