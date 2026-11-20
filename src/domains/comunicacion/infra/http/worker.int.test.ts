import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { ok } from '@shared/result.ts';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearVacante } from '../../../../../test/db/fixtures.ts';
import { correrTrabajoComunicacion } from '../../application/trabajo.ts';
import { crearReglasVacanteSql } from '../reglas-sql.ts';
import { crearContactosDesdeCaptacion, crearLinksGestion } from '../adaptadores-dominio.ts';
import { crearHandlerWorker } from './worker.ts';

const LEAD = '0190d3a0-0000-7000-8000-0000000000d1';
const CITA = '0190d3a0-0000-7000-8000-0000000000d2';

describe('handler comunicacion-worker', () => {
  const log = crearLogger({}, () => {});
  const h = crearHandlerWorker({ secreto: 's'.repeat(32), log, correr: async () => ({ x: 1 }) });
  it('exige POST y Bearer correcto', async () => {
    expect((await h(new Request('https://f', { method: 'GET' }))).status).toBe(405);
    expect((await h(new Request('https://f', { method: 'POST', headers: { authorization: 'Bearer malo' } }))).status).toBe(401);
    const r = await h(new Request('https://f', { method: 'POST', headers: { authorization: `Bearer ${'s'.repeat(32)}` } }));
    expect(await r.json()).toEqual({ ok: true, resumen: { x: 1 } });
  });
  it('secreto vacío nunca autoriza; error interno → 500 genérico', async () => {
    expect((await crearHandlerWorker({ secreto: '', log, correr: async () => 1 })(new Request('https://f', { method: 'POST', headers: { authorization: 'Bearer ' } }))).status).toBe(401);
    const falla = crearHandlerWorker({ secreto: 'k', log, correr: async () => { throw new Error('db 528112345678'); } });
    const r = await falla(new Request('https://f', { method: 'POST', headers: { authorization: 'Bearer k' } }));
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('5281');
  });
});

describe('adaptadores hacia otros dominios', () => {
  it('links de gestión: URL pública con el token firmado por citas', async () => {
    const l = crearLinksGestion(async (i, s) => `${i.accion}.${s.length}`, 'x'.repeat(32), 'https://369.mx/');
    expect(await l.firmar({ citaId: CITA, accion: 'cancelar', expiraEn: '2026-11-19T17:00:00Z' })).toBe('https://369.mx/cita?t=cancelar.32');
  });
  it('contactos: mapea captacion.obtenerContactoLead y null si el lead no existe', async () => {
    const c = crearContactosDesdeCaptacion(async (_sql, id) => (id === LEAD ? { telefonoE164: '528112345678', email: null, nombrePila: 'Ana', folio: 'F', visitorId: null } : null) as never, {} as never);
    expect(await c.obtener(LEAD)).toEqual({ telefonoE164: '528112345678', email: null, nombrePila: 'Ana', folio: 'F' });
    expect(await c.obtener(CITA)).toBeNull();
  });
});

describe('correrTrabajoComunicacion (outbox → cola → envío)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await crearTestDb();
  }, 120_000);
  afterEach(async () => {
    await db.close();
  });

  it('CitaConfirmada termina en una confirmación enviada y recordatorios en espera', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql);
    await db.sql.query(`select shared.publicar_evento('CitaConfirmada', $1::jsonb, $2::uuid, 'c-1')`, [
      JSON.stringify({ cita_id: CITA, lead_id: LEAD, vacante_id: vacanteId, cliente_id: clienteId, inicio: '2030-11-19T17:00:00.000Z', fin: '2030-11-19T17:30:00.000Z', folio: 'F-1', nombre_pila: 'Ana', reglas_version: 1, event_id: 'e' }),
      clienteId,
    ]);
    const enviados: string[] = [];
    const logs: string[] = [];
    const r = await correrTrabajoComunicacion({
      sql: db.servicio,
      clock: new FixedClock(new Date('2030-11-16T17:00:00Z')),
      canales: { whatsapp: { proveedor: 'evolution', enviarTexto: async (_t, texto) => (enviados.push(texto), ok({ proveedorId: 'w1' })) } },
      contactos: { obtener: async () => ({ telefonoE164: '528112345678', email: null, nombrePila: 'Ana', folio: 'F-1' }) },
      reglas: crearReglasVacanteSql(db.servicio),
      reglasEn: (tx) => crearReglasVacanteSql(tx),
      links: { firmar: async (i) => `https://369.mx/cita?t=${i.accion}` },
      otpKey: Buffer.alloc(32).toString('base64'),
      pepper: 'p',
      logger: crearLogger({}, (l) => logs.push(l)),
    });
    expect(r.outbox).toMatchObject({ eventos: 1, encolados: 3 });
    expect(r.envios).toMatchObject({ tomados: 1, enviados: 1 });
    expect(enviados[0]).toContain('https://369.mx/cita?t=cancelar');
    expect(logs.join('\n')).toContain('c-1');
  });
});
