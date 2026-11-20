/** Integración del formulario B2B (CAP-09) y de la API pública obtenerContactoLead. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@shared/ids.ts';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearVacante } from '../../../../test/db/fixtures.ts';
import { crearDepsPrueba } from '../infra/testing/fakes.ts';
import { obtenerContactoLead } from '../index.ts';
import { registrarContactoB2B } from './contacto-b2b.ts';
import { postular } from './postular.ts';

let db: TestDb;
let t: ReturnType<typeof crearDepsPrueba>;
const ctx = { ip: '189.203.1.2', correlationId: null };
beforeEach(async () => { db = await crearTestDb(); t = crearDepsPrueba(db.servicio); }, 120_000);
afterEach(async () => { await db.close(); });

const b2b = (c: Record<string, unknown> = {}) => ({
  nombre: 'Laura Ríos', empresa: 'ACME', email: 'Laura@ACME.mx', servicio: 'Solución integral', mensaje: '20 asesores',
  consentimiento: { aceptado: true, version: '2026-11-13' }, turnstile_token: 'ok', ...c,
});

describe('contacto B2B', () => {
  it('guarda el contacto con versión de consentimiento', async () => {
    const r = await registrarContactoB2B(t.deps, b2b(), ctx);
    expect(r.ok).toBe(true);
    const { rows } = await db.sql.query<Record<string, unknown>>('select * from captacion.contactos_b2b');
    expect(rows[0]).toMatchObject({ nombre: 'Laura Ríos', email: 'laura@acme.mx', servicio: 'Solución integral', consentimiento_version: '2026-11-13', cliente_id: '00000000-0000-0000-0000-000000000369' });
  });
  it('anti-bot, consentimiento, formato y límite por IP', async () => {
    expect(await registrarContactoB2B(t.deps, b2b({ turnstile_token: 'malo' }), ctx)).toEqual({ ok: false, error: { codigo: 'ANTIBOT_INVALIDO' } });
    expect(await registrarContactoB2B(t.deps, b2b({ turnstile_token: 'caido' }), ctx)).toEqual({ ok: false, error: { codigo: 'ANTIBOT_NO_DISPONIBLE' } });
    expect(await registrarContactoB2B(t.deps, b2b({ consentimiento: undefined }), ctx)).toMatchObject({ ok: false, error: { codigo: 'CONSENTIMIENTO_REQUERIDO' } });
    expect(await registrarContactoB2B(t.deps, b2b({ x: 1 }), ctx)).toMatchObject({ ok: false, error: { codigo: 'FORMATO_INVALIDO' } });
    for (let i = 0; i < 10; i++) expect((await registrarContactoB2B(t.deps, b2b(), ctx)).ok).toBe(true);
    expect(await registrarContactoB2B(t.deps, b2b(), ctx)).toEqual({ ok: false, error: { codigo: 'LIMITE_IP' } });
  });
});

describe('obtenerContactoLead (API pública para comunicación)', () => {
  it('devuelve el contacto del lead y null tras suprimir o anonimizar', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql, { slug: 'agente-smart' });
    const r = await postular(t.deps, {
      vacante: 'agente-smart', nombre: 'Ana Gómez', telefono: '8112345678', email: 'ana@x.mx',
      respuestas: { edad: 20, manejo_pc: 'si', papeleria: 'si' }, slot_inicio: '2026-11-17T16:00:00.000Z',
      consentimiento: { aceptado: true, version: 'v1' }, turnstile_token: 'ok', event_id: uuidv7(), atribucion: { visitor_id: 'vis-9' },
    }, ctx);
    if (!r.ok) throw new Error('postular falló');
    expect(await obtenerContactoLead(db.servicio, r.value.leadId)).toEqual({
      telefonoE164: '528112345678', email: 'ana@x.mx', nombrePila: 'Ana', folio: r.value.folio, visitorId: 'vis-9', vacanteId, clienteId,
    });
    expect(await obtenerContactoLead(db.servicio, 'no-es-uuid')).toBeNull();
    await db.sql.query('select captacion.anonimizar_lead($1)', [r.value.leadId]);
    expect(await obtenerContactoLead(db.servicio, r.value.leadId)).toBeNull();
    await db.sql.query('select captacion.suprimir_lead($1)', [r.value.leadId]);
    expect(await obtenerContactoLead(db.servicio, r.value.leadId)).toBeNull();
  });
});
