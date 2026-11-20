/** Handler gestionar-cita (POST con token firmado): C15 → 401, CIT-11 cancelar / reprogramar. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearVacante } from '@test/db/fixtures';
import { confirmarCita, firmarLinkGestion, retenerSlot } from '../../index.ts';
import { crearHandlerGestionarCita } from './gestionarCita.ts';
import { crearLimitadorMemoria } from './limitador.ts';

const ORIGEN = 'https://369capitalhumano.com';
const SECRETO = 'links-secret-de-pruebas-0123456789abcdef';
const MARTES_10 = '2026-11-17T16:00:00.000Z';
let db: TestDb;
let clock: FixedClock;
beforeEach(async () => {
  db = await crearTestDb();
  clock = new FixedClock(new Date('2026-11-17T02:00:00Z'));
}, 120_000);
afterEach(async () => { await db?.close(); });

const handler = (max = 100) =>
  crearHandlerGestionarCita({
    sql: db.servicio,
    clock,
    allowedOrigin: ORIGEN,
    secreto: SECRETO,
    contactos: { datosCita: async () => ({ folio: 'F-1', nombrePila: 'Ana' }) },
    limitador: crearLimitadorMemoria({ max, ventanaMs: 60_000, clock }),
    sink: () => {},
  });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x/gestionar-cita', {
    method: 'POST',
    headers: { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function citaConfirmada() {
  const { vacanteId } = await crearVacante(db.sql);
  const leadId = globalThis.crypto.randomUUID();
  const r = await db.servicio.transaction((tx) => retenerSlot(tx, { vacanteId, leadId, inicio: MARTES_10 }, clock));
  if (!r.ok) throw new Error(r.error);
  await db.servicio.transaction((tx) => confirmarCita(tx, { citaId: r.value.citaId, folio: 'F-1', nombrePila: 'Ana', eventId: globalThis.crypto.randomUUID() }, clock));
  return { citaId: r.value.citaId, vacanteId };
}
const token = (citaId: string, accion: 'cancelar' | 'reprogramar', expiraEn = MARTES_10) => firmarLinkGestion({ citaId, accion, expiraEn }, SECRETO);
const estado = async (id: string) => (await db.sql.query<{ estado: string }>('select estado from citas.citas where id = $1', [id])).rows[0]!.estado;

describe('POST /gestionar-cita', () => {
  it('C15 · token vencido o alterado → 401', async () => {
    const { citaId } = await citaConfirmada();
    const vencido = await token(citaId, 'cancelar', '2026-11-17T01:00:00Z');
    const r1 = await handler()(post({ token: vencido }));
    expect(r1.status).toBe(401);
    expect(await r1.json()).toEqual({ error: 'TOKEN_VENCIDO' });
    const t = await token(citaId, 'cancelar');
    const alterado = t.slice(0, -2) + (t.endsWith('00') ? '11' : '00');
    expect((await handler()(post({ token: alterado }))).status).toBe(401);
    expect(await estado(citaId)).toBe('confirmada');
  });

  it('cancelar con link válido → 200, cancelada; repetir → 409', async () => {
    const { citaId } = await citaConfirmada();
    const t = await token(citaId, 'cancelar');
    const r = await handler()(post({ token: t }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ accion: 'cancelar', cita_id: citaId, estado: 'cancelada' });
    expect(await estado(citaId)).toBe('cancelada');
    const again = await handler()(post({ token: t }));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'TRANSICION_INVALIDA' });
  });

  it('consultar devuelve la cita (sin PII) y, para reprogramar, los slots disponibles', async () => {
    const { citaId, vacanteId } = await citaConfirmada();
    const r = await handler()(post({ token: await token(citaId, 'reprogramar'), operacion: 'consultar' }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { accion: string; cita: Record<string, unknown>; slots: Array<{ inicio_utc: string }> };
    expect(body.accion).toBe('reprogramar');
    expect(body.cita).toEqual({ cita_id: citaId, vacante_id: vacanteId, estado: 'confirmada', inicio_utc: MARTES_10, fin_utc: '2026-11-17T17:30:00.000Z', inicio_local: '2026-11-17T10:00:00-06:00', zona_horaria: 'America/Mexico_City' });
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots.some((s) => s.inicio_utc === MARTES_10)).toBe(false);
    const c = await handler()(post({ token: await token(citaId, 'cancelar'), operacion: 'consultar' }));
    expect(((await c.json()) as { slots?: unknown }).slots).toBeUndefined();
  });

  it('reprogramar: requiere nuevo_inicio; slot válido → 200; slot inválido → 409', async () => {
    const { citaId } = await citaConfirmada();
    const t = await token(citaId, 'reprogramar');
    expect((await handler()(post({ token: t }))).status).toBe(400);
    const malo = await handler()(post({ token: t, nuevo_inicio: '2026-11-18T16:10:00Z' }));
    expect(malo.status).toBe(409);
    expect(await malo.json()).toEqual({ error: 'SLOT_INVALIDO' });
    const r = await handler()(post({ token: t, nuevo_inicio: '2026-11-18T16:00:00Z' }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { cita_id: string; inicio_utc: string };
    expect(body.inicio_utc).toBe('2026-11-18T16:00:00.000Z');
    expect(await estado(citaId)).toBe('reprogramada');
    expect(await estado(body.cita_id)).toBe('confirmada');
  });

  it('cita inexistente → 404; cita que ya empezó → 409', async () => {
    const t = await token(globalThis.crypto.randomUUID(), 'cancelar');
    expect((await handler()(post({ token: t }))).status).toBe(404);
    expect((await handler()(post({ token: t, operacion: 'consultar' }))).status).toBe(404);
    const { citaId } = await citaConfirmada();
    const t2 = await token(citaId, 'cancelar', '2026-11-18T00:00:00Z');
    clock.set('2026-11-17T16:30:00Z');
    expect((await handler()(post({ token: t2 }))).status).toBe(409);
  });

  it('validación de la petición: método, origen, JSON, esquema, tamaño y rate limit', async () => {
    expect((await handler()(new Request('https://x/g', { method: 'GET', headers: { origin: ORIGEN } }))).status).toBe(405);
    expect((await handler()(new Request('https://x/g', { method: 'OPTIONS', headers: { origin: ORIGEN } }))).status).toBe(204);
    expect((await handler()(post({ token: 'x' }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handler()(post('{no json'))).status).toBe(400);
    expect((await handler()(post({ token: 'x', operacion: 'borrar' }))).status).toBe(400);
    expect((await handler()(post({ token: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await handler()(post({ token: 'x' }, { 'content-type': 'text/plain' }))).status).toBe(415);
    const h = handler(1);
    expect((await h(post({ token: 'x' }))).status).toBe(401);
    expect((await h(post({ token: 'x' }))).status).toBe(429);
  });
});
