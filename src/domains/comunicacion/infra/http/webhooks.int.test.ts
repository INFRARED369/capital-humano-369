import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearVacante } from '../../../../../test/db/fixtures.ts';
import update from '../__fixtures__/evolution-webhook-messages-update.json';
import baja from '../__fixtures__/evolution-webhook-messages-upsert-baja.json';
import nbxStatus from '../__fixtures__/nbx-webhook-status.json';
import { firmarWebhook } from '../../domain/webhook.ts';
import { hmacTelefono } from '../../application/privacidad.ts';
import { crearHandlerWebhook, type DepsWebhook } from './webhooks.ts';

const SECRETO = 'whsec';
const PEPPER = 'pepper';
const ahora = new Date('2026-11-16T17:00:05Z');
const ts = String(Math.floor(ahora.getTime() / 1000));

let db: TestDb;
let deps: DepsWebhook;
let logs: string[];

beforeEach(async () => {
  db = await crearTestDb();
  logs = [];
  deps = { sql: db.servicio, clock: new FixedClock(ahora), secreto: SECRETO, pepper: PEPPER, logger: crearLogger({}, (l) => logs.push(l)) };
}, 120_000);
afterEach(async () => {
  await db?.close();
});

async function req(body: unknown, opts: { firma?: string | null; ts?: string; metodo?: string } = {}) {
  const cuerpo = typeof body === 'string' ? body : JSON.stringify(body);
  const t = opts.ts ?? ts;
  const firma = opts.firma === undefined ? await firmarWebhook(SECRETO, t, cuerpo) : opts.firma;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-369-timestamp': t };
  if (firma) headers['x-369-signature'] = firma;
  return new Request('https://fn/webhook', { method: opts.metodo ?? 'POST', headers, body: opts.metodo === 'GET' ? undefined : cuerpo });
}

async function mensajeEnviado(proveedor: string, proveedorId: string) {
  const { vacanteId, clienteId } = await crearVacante(db.sql);
  await db.sql.query(
    `insert into comunicacion.mensajes (id, cliente_id, vacante_id, tipo, canal, estado, llave, prioridad, proveedor, proveedor_id)
     values (gen_random_uuid(), $1, $2, 'confirmacion', 'whatsapp', 'enviado', 'k', 2, $3, $4)`,
    [clienteId, vacanteId, proveedor, proveedorId],
  );
}

describe('M5 · firma y anti-replay', () => {
  const evolution = () => crearHandlerWebhook('evolution', deps);

  it('firma inválida → 401 y no toca la BD', async () => {
    const r = await evolution()(await req(update, { firma: 'sha256=' + '0'.repeat(64) }));
    expect(r.status).toBe(401);
    expect((await db.sql.query(`select 1 from comunicacion.webhooks_vistos`)).rows).toHaveLength(0);
  });

  it('sin firma → 401; timestamp viejo → 401', async () => {
    expect((await evolution()(await req(update, { firma: null }))).status).toBe(401);
    const viejo = String(Number(ts) - 600);
    expect((await evolution()(await req(update, { ts: viejo }))).status).toBe(401);
  });

  it('método distinto de POST → 405; JSON inválido firmado → 400', async () => {
    expect((await evolution()(await req('', { metodo: 'GET' }))).status).toBe(405);
    expect((await evolution()(await req('{no json'))).status).toBe(400);
  });

  it('replay del mismo cuerpo → 200 duplicado sin reprocesar', async () => {
    await mensajeEnviado('evolution', 'BAE594145F4C59B4');
    const h = evolution();
    expect(await (await h(await req(update))).json()).toMatchObject({ ok: true, duplicado: false });
    expect(await (await h(await req(update))).json()).toMatchObject({ ok: true, duplicado: true });
  });
});

describe('Evolution', () => {
  it('messages.update DELIVERY_ACK → estado_entrega entregado por id de proveedor', async () => {
    await mensajeEnviado('evolution', 'BAE594145F4C59B4');
    const r = await crearHandlerWebhook('evolution', deps)(await req(update));
    expect(r.status).toBe(200);
    const { rows } = await db.sql.query<{ estado_entrega: string }>(`select estado_entrega from comunicacion.mensajes`);
    expect(rows[0]!.estado_entrega).toBe('entregado');
  });

  it('READ → leido y no retrocede a entregado', async () => {
    await mensajeEnviado('evolution', 'BAE594145F4C59B4');
    const h = crearHandlerWebhook('evolution', deps);
    await h(await req({ ...update, data: { ...update.data, status: 'READ' } }));
    await h(await req(update));
    const { rows } = await db.sql.query<{ estado_entrega: string }>(`select estado_entrega from comunicacion.mensajes`);
    expect(rows[0]!.estado_entrega).toBe('leido');
  });

  it('"BAJA" del candidato → opt-out permanente por HMAC, sin responderle (COM-07) y sin PII en logs', async () => {
    const r = await crearHandlerWebhook('evolution', deps)(await req(baja));
    expect(await r.json()).toMatchObject({ ok: true, opt_out: true });
    const { rows } = await db.sql.query<{ telefono_hmac: string; origen: string }>(`select telefono_hmac, origen from comunicacion.opt_out`);
    expect(rows).toEqual([{ telefono_hmac: await hmacTelefono(PEPPER, '528112345678'), origen: 'webhook' }]);
    expect(logs.join('\n')).not.toMatch(/8112345678/);
  });

  it('un mensaje entrante normal se ignora', async () => {
    const otro = { ...baja, data: { ...baja.data, message: { conversation: 'Hola, ¿a qué hora es?' } } };
    expect(await (await crearHandlerWebhook('evolution', deps)(await req(otro))).json()).toMatchObject({ ok: true, opt_out: false });
    expect((await db.sql.query(`select 1 from comunicacion.opt_out`)).rows).toHaveLength(0);
  });

  it('eventos desconocidos → 200 ignorado', async () => {
    expect((await crearHandlerWebhook('evolution', deps)(await req({ event: 'connection.update', data: {} }))).status).toBe(200);
  });
});

describe('NBX (Q-1, genérico)', () => {
  it('delivered → entregado; failed → fallido', async () => {
    await mensajeEnviado('nbx', 'nbx-7f3a9c');
    const h = crearHandlerWebhook('nbx', deps);
    expect((await h(await req(nbxStatus))).status).toBe(200);
    expect((await db.sql.query<{ estado_entrega: string }>(`select estado_entrega from comunicacion.mensajes`)).rows[0]!.estado_entrega).toBe('entregado');
    await h(await req({ ...nbxStatus, status: 'failed', timestamp: 'x' }));
    expect((await db.sql.query<{ estado_entrega: string }>(`select estado_entrega from comunicacion.mensajes`)).rows[0]!.estado_entrega).toBe('fallido');
  });
});

describe('NFR-SEG-05 · Evolution v2 sin HMAC: token en cabecera (webhook.headers) + anti-replay + frescura', () => {
  const TOKEN = 'tok-evolution-0123456789abcdef';
  // El fixture trae date_time = hora LOCAL de Evolution (CDMX) con sufijo Z: 11:00:05Z ≙ 17:00:05 UTC.
  const evolutionToken = () => crearHandlerWebhook('evolution', { ...deps, secreto: TOKEN, aceptarToken: true, desfaseMin: -360 });
  const reqToken = (body: unknown, token: string | null = TOKEN) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) headers['x-369-webhook-token'] = token;
    return new Request('https://fn/webhook', { method: 'POST', headers, body: JSON.stringify(body) });
  };

  it('token correcto → 200 y procesa el estado de entrega', async () => {
    await mensajeEnviado('evolution', 'BAE594145F4C59B4');
    const r = await evolutionToken()(reqToken(update));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, duplicado: false, actualizados: 1 });
  });

  it('token ausente o incorrecto → 401 sin tocar la BD (y la métrica de rechazo)', async () => {
    expect((await evolutionToken()(reqToken(update, null))).status).toBe(401);
    expect((await evolutionToken()(reqToken(update, TOKEN.slice(0, -1) + 'X'))).status).toBe(401);
    expect((await db.sql.query(`select 1 from comunicacion.webhooks_vistos`)).rows).toHaveLength(0);
    expect(logs.filter((l) => l.includes('comunicacion.webhook_rechazado'))).toHaveLength(2);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('sin aceptarToken (NBX o configuración por defecto) el token NO basta → 401', async () => {
    const h = crearHandlerWebhook('nbx', { ...deps, secreto: TOKEN });
    expect((await h(reqToken(nbxStatus))).status).toBe(401);
  });

  it('replay: el mismo evento de Evolution (mismo id y estado) aunque cambie el cuerpo → ignorado (duplicado)', async () => {
    await mensajeEnviado('evolution', 'BAE594145F4C59B4');
    const h = evolutionToken();
    expect(await (await h(reqToken(update))).json()).toMatchObject({ duplicado: false });
    const reenviado = { ...update, date_time: '2026-11-16T11:00:06.000Z' };
    const r = await h(reqToken(reenviado));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, duplicado: true });
    const { rows } = await db.sql.query<{ evento_id: string }>(`select evento_id from comunicacion.webhooks_vistos`);
    expect(rows).toEqual([{ evento_id: 'messages.update:BAE594145F4C59B4:DELIVERY_ACK' }]);
  });

  it('evento viejo (date_time fuera de ±5 min) o sin date_time → 401', async () => {
    expect((await evolutionToken()(reqToken({ ...update, date_time: '2026-11-16T10:50:00.000Z' }))).status).toBe(401);
    const { date_time: _omitido, ...sinFecha } = update;
    expect((await evolutionToken()(reqToken(sinFecha))).status).toBe(401);
    expect((await db.sql.query(`select 1 from comunicacion.webhooks_vistos`)).rows).toHaveLength(0);
  });

  it('"BAJA" con token → opt-out registrado (COM-05) y sin PII en logs', async () => {
    const r = await evolutionToken()(reqToken(baja));
    expect(await r.json()).toMatchObject({ ok: true, opt_out: true });
    const { rows } = await db.sql.query<{ telefono_hmac: string }>(`select telefono_hmac from comunicacion.opt_out`);
    expect(rows).toEqual([{ telefono_hmac: await hmacTelefono(PEPPER, '528112345678') }]);
    expect(logs.join('\n')).not.toMatch(/8112345678/);
  });

  it('con aceptarToken la firma HMAC sigue funcionando (relay o NBX)', async () => {
    const h = crearHandlerWebhook('evolution', { ...deps, aceptarToken: true });
    expect((await h(await req(update))).status).toBe(200);
  });
});
