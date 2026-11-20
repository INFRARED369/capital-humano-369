/**
 * Privacidad (PRV-02, Política de retención: evento en Zoho hasta cita + 30 días; R3, R6).
 * citas.zoho_suprimir_lead(uuid) y citas.zoho_retencion_aplicar(timestamptz).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearUsuario, crearVacante, guardarReglas } from '@test/db/fixtures';
import { CalendarioFalso } from '../testing/calendarioFalso.ts';
import { ejecutarWorkerZoho } from '../application/worker.ts';
import { reconciliarZoho } from '../application/reconciliar.ts';
import { crearDepsReconciliacionSql, crearDepsZohoSql } from './sqlZoho.ts';

const CAL = 'c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
let db: TestDb;
let zoho: CalendarioFalso;
let vac: { vacanteId: string; clienteId: string };
const uuid = () => globalThis.crypto.randomUUID();
const enDias = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const worker = () => ejecutarWorkerZoho(crearDepsZohoSql({ sql: db.servicio, calendario: zoho, clock: new FixedClock(new Date()), logger: crearLogger({}, () => {}), panelUrl: 'https://panel.369.mx' }));

async function confirmar(over: Record<string, unknown> = {}) {
  const p = { cita_id: uuid(), lead_id: uuid(), vacante_id: vac.vacanteId, cliente_id: vac.clienteId, inicio: enDias(2), fin: enDias(2.02),
    folio: 'V-9', nombre_pila: 'Lucía', reglas_version: 1, event_id: uuid(), ...over };
  await db.sql.query(`select shared.publicar_evento('CitaConfirmada', $1::jsonb, $2)`, [JSON.stringify(p), vac.clienteId]);
  return p;
}
const registro = async (citaId: string) =>
  (await db.sql.query<Record<string, unknown>>('select * from citas.zoho_eventos where cita_id = $1', [citaId])).rows[0];
const fn = async (sqlFn: string, arg: unknown) =>
  (await db.servicio.query<{ r: Record<string, number> }>(`select ${sqlFn}($1) as r`, [arg])).rows[0]!.r;

beforeEach(async () => {
  db = await crearTestDb();
  zoho = new CalendarioFalso();
  vac = await crearVacante(db.sql);
  await guardarReglas(db.sql, vac.vacanteId, { zoho_calendar_uid: CAL });
}, 60_000);
afterEach(async () => { await db.close(); });

describe('citas.zoho_suprimir_lead (R6 · ARCO / revocación)', () => {
  it('anonimiza el registro, encola el borrado y el worker borra el evento en Zoho', async () => {
    const p = await confirmar();
    const otro = await confirmar();
    await worker();
    expect(zoho.eventos(CAL)).toHaveLength(2);

    expect(await fn('citas.zoho_suprimir_lead', p.lead_id)).toEqual({ zoho_eventos: 1, borrados_encolados: 1 });
    expect(await registro(p.cita_id)).toMatchObject({ nombre_pila: null, vigente: false, estado_sync: 'pendiente' });
    await worker();
    expect(zoho.eventos(CAL).map((e) => e.uidPropio)).toEqual([`cita-${otro.cita_id}`]);
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'borrado' });
  });

  it('es idempotente y no encola de nuevo lo ya borrado', async () => {
    const p = await confirmar();
    await worker();
    await fn('citas.zoho_suprimir_lead', p.lead_id);
    await worker();
    expect(await fn('citas.zoho_suprimir_lead', p.lead_id)).toEqual({ zoho_eventos: 1, borrados_encolados: 0 });
    const { rows } = await db.sql.query(`select * from shared.cola where cola = 'zoho-sync' and estado = 'pendiente'`);
    expect(rows).toEqual([]);
  });

  it('lead sin citas → conteos en cero', async () => {
    expect(await fn('citas.zoho_suprimir_lead', uuid())).toEqual({ zoho_eventos: 0, borrados_encolados: 0 });
  });

  it('la reconciliación no vuelve a publicar una cita suprimida', async () => {
    const p = await confirmar();
    await worker();
    await fn('citas.zoho_suprimir_lead', p.lead_id);
    await worker();
    await reconciliarZoho(crearDepsReconciliacionSql({ sql: db.servicio, calendario: zoho, clock: new FixedClock(new Date()), logger: crearLogger({}, () => {}), panelUrl: 'https://panel.369.mx' }));
    expect(zoho.eventos(CAL)).toEqual([]);
  });
});

describe('citas.zoho_retencion_aplicar (cita + 30 días · R3)', () => {
  it('borra el evento de citas con más de 30 días y deja las recientes', async () => {
    const vieja = await confirmar({ inicio: enDias(-31), fin: enDias(-30.98) });
    const reciente = await confirmar({ inicio: enDias(-29), fin: enDias(-28.98) });
    await worker();
    expect(zoho.eventos(CAL)).toHaveLength(2);

    const r = await fn('citas.zoho_retencion_aplicar', new Date().toISOString());
    expect(r).toMatchObject({ zoho_evento_cita_30d: 1 });
    expect(await registro(vieja.cita_id)).toMatchObject({ nombre_pila: null, vigente: false });
    expect(await registro(reciente.cita_id)).toMatchObject({ nombre_pila: 'Lucía', vigente: true });
    await worker();
    expect(zoho.eventos(CAL).map((e) => e.uidPropio)).toEqual([`cita-${reciente.cita_id}`]);
  });

  it('idempotente; en una corrida posterior purga las filas ya borradas en Zoho', async () => {
    const vieja = await confirmar({ inicio: enDias(-31), fin: enDias(-30.98) });
    await worker();
    await fn('citas.zoho_retencion_aplicar', new Date().toISOString());
    expect(await fn('citas.zoho_retencion_aplicar', new Date().toISOString())).toMatchObject({ zoho_evento_cita_30d: 0, purgados: 0 });
    await worker();
    expect(await fn('citas.zoho_retencion_aplicar', new Date().toISOString())).toMatchObject({ zoho_evento_cita_30d: 0, purgados: 1 });
    expect(await registro(vieja.cita_id)).toBeUndefined();
  });

  it('citas sin calendario de más de 30 días: se anonimizan sin encolar nada', async () => {
    const otra = await crearVacante(db.sql, { clienteId: vac.clienteId });
    const p = await confirmar({ vacante_id: otra.vacanteId, inicio: enDias(-40), fin: enDias(-39.98) });
    await worker();
    expect(await fn('citas.zoho_retencion_aplicar', new Date().toISOString())).toMatchObject({ zoho_evento_cita_30d: 1 });
    expect(await registro(p.cita_id)).toMatchObject({ nombre_pila: null, estado_sync: 'borrado' });
    const { rows } = await db.sql.query(`select * from shared.cola where cola = 'zoho-sync'`);
    expect(rows).toEqual([]);
  });
});

describe('permisos', () => {
  it('solo service_role ejecuta las funciones de privacidad', async () => {
    const admin = await crearUsuario(db.sql, 'admin');
    await expect(db.comoUsuario(admin, (s) => s.query(`select citas.zoho_suprimir_lead($1)`, [uuid()]))).rejects.toThrow(/permission denied/);
    await expect(db.comoUsuario(admin, (s) => s.query(`select citas.zoho_retencion_aplicar(now())`))).rejects.toThrow(/permission denied/);
    await expect(db.como('anon', null, (s) => s.query(`select citas.zoho_retencion_aplicar(now())`))).rejects.toThrow(/permission denied/);
  });
});
