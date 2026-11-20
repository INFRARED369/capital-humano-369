/** NFR-OBS-01 · De punta a punta: PGlite (shared.evaluar_alertas) → webhook falso → shared.alertas notificada. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { ejecutarAlertas } from '../application/ejecutar.ts';
import { crearNotificadorWebhook } from './notificadores.ts';
import { crearRepoAlertasSql } from './sql.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 120_000);
afterEach(async () => { await db.close(); });

describe('alertas de punta a punta', () => {
  it('dead letter con PII en el motivo → 1 notificación sin PII, marcada; la siguiente corrida no repite', async () => {
    await db.sql.query(`insert into privacidad.registro_supresiones (tipo, ejecutado_en) values ('retencion', '2026-11-17T09:00:00Z')`);
    await db.sql.query(`insert into shared.dead_letter (cola_id, cola, payload, motivo) values (1, 'comunicacion', '{"mensaje_id":"m"}', 'tel 8112345678 ana@x.mx')`);
    const cuerpos: string[] = [];
    let status = 500;
    const fetchFalso = (async (_u: string, init: RequestInit) => { cuerpos.push(String(init.body)); return new Response('', { status }); }) as unknown as typeof fetch;
    const deps = {
      repo: crearRepoAlertasSql(db.servicio),
      notificadores: [crearNotificadorWebhook({ url: 'https://hooks.slack.com/services/x', fetch: fetchFalso, entorno: 'pruebas' })],
      clock: new FixedClock(new Date('2026-11-17T18:00:00Z')),
      log: crearLogger({}, () => {}),
    };
    expect(await ejecutarAlertas(deps)).toMatchObject({ nuevas: 1, pendientes: 1, notificadas: 0, canales_error: ['webhook'] });
    status = 200;
    expect(await ejecutarAlertas(deps)).toMatchObject({ nuevas: 0, pendientes: 1, notificadas: 1 });
    expect(await ejecutarAlertas(deps)).toMatchObject({ nuevas: 0, pendientes: 0, notificadas: 0 });
    expect(cuerpos).toHaveLength(2);
    expect(JSON.parse(cuerpos[1]!)).toMatchObject({ alertas: [{ tipo: 'dead_letter', severidad: 'critica', detalle: { cola: 'comunicacion', nuevas: 1 } }] });
    expect(cuerpos.join('')).not.toMatch(/8112345678|ana@x\.mx/);
    const { rows } = await db.sql.query<{ canales: string; intentos_notificacion: number }>(`select canales, intentos_notificacion from shared.alertas`);
    expect(rows).toEqual([{ canales: 'webhook', intentos_notificacion: 1 }]);
  });
});
