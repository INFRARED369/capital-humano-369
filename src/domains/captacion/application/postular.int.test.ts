/** Integración de `postular` con PGlite y puertos falsos (P1–P7, CAP-05..CAP-08, O5). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@shared/ids.ts';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearVacante } from '../../../../test/db/fixtures.ts';
import { crearDepsPrueba } from '../infra/testing/fakes.ts';
import { postular } from './postular.ts';

let db: TestDb;
let t: ReturnType<typeof crearDepsPrueba>;
let vacante: { vacanteId: string; clienteId: string };
const ctx = { ip: '189.203.1.2', correlationId: 'corr-1' };

beforeEach(async () => {
  db = await crearTestDb();
  vacante = await crearVacante(db.sql, { slug: 'agente-smart' });
  t = crearDepsPrueba(db.servicio);
}, 120_000);
afterEach(async () => { await db.close(); });

const cuerpo = (cambios: Record<string, unknown> = {}) => ({
  vacante: 'agente-smart',
  nombre: 'mariana garza',
  telefono: '8112345678',
  email: 'mariana@correo.mx',
  respuestas: { edad: 22, manejo_pc: 'si', papeleria: 'si' },
  slot_inicio: '2026-11-17T16:00:00.000Z',
  consentimiento: { aceptado: true, version: '2026-11-13' },
  turnstile_token: 'ok',
  event_id: uuidv7(),
  atribucion: { visitor_id: 'vis-1', utm_source: 'facebook', fbclid: 'fb.1' },
  ...cambios,
});

const contar = async (tabla: string, where = 'true') => Number((await db.sql.query<{ n: number }>(`select count(*)::int as n from ${tabla} where ${where}`)).rows[0]!.n);

describe('P1 / P3 / CAP-05 / CAP-06 · lead válido y transacción completa', () => {
  it('respuestas "no" a todo crean lead, folio, retención, OTP encolado y LeadCreado (E2E-02)', async () => {
    const c = cuerpo({ respuestas: { edad: 15, manejo_pc: 'no', papeleria: 'no' } });
    const r = await postular(t.deps, c, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.folio).toMatch(/^369-[A-Z2-9]{6}$/);
    expect(r.value.reutilizado).toBe(false);
    expect(r.value.otp.reenviosRestantes).toBe(2);

    const { rows: [lead] } = await db.sql.query<Record<string, unknown>>('select * from captacion.leads');
    expect(lead).toMatchObject({
      id: r.value.leadId, folio: r.value.folio, vacante_id: vacante.vacanteId, cliente_id: vacante.clienteId,
      nombre: 'mariana garza', nombre_pila: 'Mariana', telefono: '528112345678', email: 'mariana@correo.mx',
      respuestas: { edad: 15, manejo_pc: 'no', papeleria: 'no' }, consentimiento_version: '2026-11-13', estado: 'pendiente_otp',
      event_id: c.event_id, visitor_id: 'vis-1', cita_id: t.agenda.retenciones[0]!.citaId,
    });
    expect(lead!.telefono_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(lead!.consentido_en as string).toISOString()).toBe('2026-11-16T15:00:00.000Z');

    expect(t.agenda.retenciones).toEqual([expect.objectContaining({ vacanteId: vacante.vacanteId, leadId: r.value.leadId, inicio: '2026-11-17T16:00:00.000Z' })]);
    expect(t.mensajeria.enviados).toEqual([expect.objectContaining({ tipo: 'otp', canal: 'whatsapp', leadId: r.value.leadId, clienteId: vacante.clienteId, codigoCifrado: expect.any(String) })]);
    expect(await contar('captacion.otp', `estado = 'vigente'`)).toBe(1);
    // Contrato de comunicación: solo codigoCifrado; sin nombre, folio ni código en variables.
    const msg = t.mensajeria.enviados[0]!;
    expect(msg.variables).toBeUndefined();
    expect(JSON.stringify(msg)).not.toMatch(new RegExp(`${r.value.folio}|mariana|8112345678`, 'i'));

    const { rows: eventos } = await db.sql.query<{ tipo: string; payload: Record<string, unknown>; correlation_id: string }>(`select tipo, payload, correlation_id from shared.outbox where tipo = 'LeadCreado'`);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload).toEqual({ lead_id: r.value.leadId, vacante_id: vacante.vacanteId, cliente_id: vacante.clienteId, folio: r.value.folio, event_id: c.event_id, visitor_id: 'vis-1', origen: 'facebook' });
    expect(eventos[0]!.correlation_id).toBe('corr-1');
  });

  it('P3 · si falla el encolado del OTP no queda nada (lead, OTP, retención, outbox)', async () => {
    t.mensajeria.fallar = true;
    await expect(postular(t.deps, cuerpo(), ctx)).rejects.toThrow(/cola caída/);
    for (const tabla of ['captacion.leads', 'captacion.otp', 'captacion.envios_limitados', 'shared.outbox', 'shared.cola']) expect(await contar(tabla), tabla).toBe(0);
  });

  it.each(['SLOT_LLENO', 'CUPO_DIARIO', 'SLOT_INVALIDO'] as const)('%s → error de horario y rollback completo (E2E-04)', async (e) => {
    t.agenda.errorRetener = e;
    const r = await postular(t.deps, cuerpo(), ctx);
    expect(r).toEqual({ ok: false, error: { codigo: e } });
    for (const tabla of ['captacion.leads', 'captacion.otp', 'shared.outbox', 'shared.cola']) expect(await contar(tabla), tabla).toBe(0);
  });
});

describe('P2 / P4 / P6 · formato, campos extra, anti-bot y consentimiento', () => {
  it('P2 · 9 dígitos → FORMATO_INVALIDO sin efectos', async () => {
    const r = await postular(t.deps, cuerpo({ telefono: '811234567' }), ctx);
    expect(!r.ok && r.error.codigo).toBe('FORMATO_INVALIDO');
    expect(await contar('captacion.leads')).toBe(0);
    expect(t.whatsapp.consultas).toEqual([]);
  });
  it('P4 · campo extra → FORMATO_INVALIDO', async () => {
    const r = await postular(t.deps, cuerpo({ estado: 'verificado' }), ctx);
    expect(!r.ok && r.error.codigo).toBe('FORMATO_INVALIDO');
  });
  it('P6 · sin consentimiento → CONSENTIMIENTO_REQUERIDO; token inválido → ANTIBOT_INVALIDO; Turnstile caído → ANTIBOT_NO_DISPONIBLE', async () => {
    expect(await postular(t.deps, cuerpo({ consentimiento: { aceptado: false, version: 'v' } }), ctx)).toMatchObject({ ok: false, error: { codigo: 'CONSENTIMIENTO_REQUERIDO' } });
    expect(await postular(t.deps, cuerpo({ turnstile_token: 'malo' }), ctx)).toEqual({ ok: false, error: { codigo: 'ANTIBOT_INVALIDO' } });
    expect(await postular(t.deps, cuerpo({ turnstile_token: 'caido' }), ctx)).toEqual({ ok: false, error: { codigo: 'ANTIBOT_NO_DISPONIBLE' } });
    expect(await contar('captacion.leads')).toBe(0);
  });
  it('vacante desconocida (sin contenido o sin fila) → VACANTE_NO_ENCONTRADA', async () => {
    expect(await postular(t.deps, cuerpo({ vacante: 'otra' }), ctx)).toEqual({ ok: false, error: { codigo: 'VACANTE_NO_ENCONTRADA' } });
    expect(await postular(t.deps, { foo: 1 }, ctx)).toEqual({ ok: false, error: { codigo: 'VACANTE_NO_ENCONTRADA' } });
    const t2 = crearDepsPrueba(db.servicio, { preguntas: { fantasma: [] } });
    expect(await postular(t2.deps, cuerpo({ vacante: 'fantasma', respuestas: {} }), ctx)).toEqual({ ok: false, error: { codigo: 'VACANTE_NO_ENCONTRADA' } });
  });
  it('vacante inactiva → VACANTE_NO_ENCONTRADA', async () => {
    await db.sql.query(`update shared.vacantes set activa = false`);
    expect(await postular(t.deps, cuerpo(), ctx)).toEqual({ ok: false, error: { codigo: 'VACANTE_NO_ENCONTRADA' } });
  });
});

describe('P7 · número sin WhatsApp', () => {
  it('WHATSAPP_INVALIDO sin retención, sin envío y sin lead', async () => {
    t.whatsapp.inexistentes.add('528112345678');
    expect(await postular(t.deps, cuerpo(), ctx)).toEqual({ ok: false, error: { codigo: 'WHATSAPP_INVALIDO' } });
    expect(t.agenda.retenciones).toEqual([]);
    expect(t.mensajeria.enviados).toEqual([]);
    expect(t.cifrador.codigos).toEqual([]);
    expect(await contar('captacion.leads')).toBe(0);
  });
  it('si Evolution no responde → VERIFICADOR_NO_DISPONIBLE (fallback a WhatsApp, CAP-10)', async () => {
    t.whatsapp.caido = true;
    expect(await postular(t.deps, cuerpo(), ctx)).toEqual({ ok: false, error: { codigo: 'VERIFICADOR_NO_DISPONIBLE' } });
  });
});

describe('canal del código: WhatsApp, SMS o correo', () => {
  it('sin WhatsApp, por SMS sí se postula: no consulta Evolution y encola por sms', async () => {
    t.whatsapp.inexistentes.add('528112345678');
    const r = await postular(t.deps, cuerpo({ canal_otp: 'sms' }), ctx);
    expect(r.ok && r.value.otp.canal).toBe('sms');
    expect(t.whatsapp.consultas).toEqual([]);
    expect(t.mensajeria.enviados).toEqual([expect.objectContaining({ tipo: 'otp', canal: 'sms' })]);
  });
  it('por correo encola por email; sin email → FORMATO_INVALIDO en el campo email', async () => {
    const r = await postular(t.deps, cuerpo({ canal_otp: 'email' }), ctx);
    expect(r.ok && r.value.otp.canal).toBe('email');
    expect(t.mensajeria.enviados.at(-1)).toMatchObject({ canal: 'email' });
    const sin = await postular(t.deps, cuerpo({ canal_otp: 'email', email: '', telefono: '8119999999' }), ctx);
    expect(sin).toMatchObject({ ok: false, error: { codigo: 'FORMATO_INVALIDO', campos: [{ campo: 'email' }] } });
  });
  it('canal deshabilitado por configuración → CANAL_NO_DISPONIBLE sin lead', async () => {
    t.deps.canalesOtp = ['whatsapp', 'email'];
    expect(await postular(t.deps, cuerpo({ canal_otp: 'sms' }), ctx)).toEqual({ ok: false, error: { codigo: 'CANAL_NO_DISPONIBLE' } });
    expect(await contar('captacion.leads')).toBe(0);
  });
});

describe('P5 · deduplicación por teléfono + vacante (30 días)', () => {
  it('reutiliza el lead: mismo folio, sin otro LeadCreado, libera la retención anterior y reemplaza el OTP', async () => {
    const a = await postular(t.deps, cuerpo(), ctx);
    t.clock.advanceMinutes(30);
    const b = await postular(t.deps, cuerpo({ nombre: 'Mariana Garza López', slot_inicio: '2026-11-18T16:00:00.000Z', respuestas: { edad: 23, manejo_pc: 'no', papeleria: 'si' } }), ctx);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.leadId).toBe(a.value.leadId);
    expect(b.value.folio).toBe(a.value.folio);
    expect(b.value.reutilizado).toBe(true);
    expect(await contar('captacion.leads')).toBe(1);
    expect(await contar('shared.outbox', `tipo = 'LeadCreado'`)).toBe(1);
    expect(t.agenda.liberadas).toEqual([{ citaId: t.agenda.retenciones[0]!.citaId, motivo: 'REPOSTULACION' }]);
    expect(await contar('captacion.otp', `estado = 'vigente'`)).toBe(1);
    expect(await contar('captacion.otp', `estado = 'reemplazado'`)).toBe(1);
    const { rows: [l] } = await db.sql.query<{ nombre: string; respuestas: unknown; cita_id: string }>('select * from captacion.leads');
    expect(l).toMatchObject({ nombre: 'Mariana Garza López', respuestas: { edad: 23, manejo_pc: 'no', papeleria: 'si' }, cita_id: t.agenda.retenciones[1]!.citaId });
  });

  it('pasados 30 días o en otra vacante → lead nuevo', async () => {
    await crearVacante(db.sql, { slug: 'otra-vacante', clienteId: vacante.clienteId });
    const t2 = crearDepsPrueba(db.servicio, { preguntas: { 'agente-smart': [], 'otra-vacante': [] } });
    await postular(t2.deps, cuerpo({ respuestas: {} }), ctx);
    const otra = await postular(t2.deps, cuerpo({ vacante: 'otra-vacante', respuestas: {} }), ctx);
    expect(otra.ok && otra.value.reutilizado).toBe(false);
    t2.clock.advance(31 * 86_400_000);
    const tarde = await postular(t2.deps, cuerpo({ respuestas: {} }), ctx);
    expect(tarde.ok && tarde.value.reutilizado).toBe(false);
    expect(await contar('captacion.leads')).toBe(3);
  });

  it('lead ya verificado → YA_POSTULADO con su folio, sin retener ni enviar', async () => {
    const a = await postular(t.deps, cuerpo(), ctx);
    await db.sql.query(`update captacion.leads set estado = 'verificado'`);
    const b = await postular(t.deps, cuerpo(), ctx);
    expect(b).toEqual({ ok: false, error: { codigo: 'YA_POSTULADO', folio: a.ok ? a.value.folio : '' } });
    expect(t.agenda.retenciones).toHaveLength(1);
    expect(t.whatsapp.consultas).toHaveLength(1);
  });

  it('un event_id ya usado por otro teléfono → EVENTO_DUPLICADO', async () => {
    const c = cuerpo();
    await postular(t.deps, c, ctx);
    expect(await postular(t.deps, { ...c, telefono: '8119998888' }, ctx)).toEqual({ ok: false, error: { codigo: 'EVENTO_DUPLICADO' } });
  });

  it('colisión de folio → reintenta con otro', async () => {
    let n = 0;
    // Las 6 primeras extracciones forman el folio 369-AAAAAA (ya ocupado); después, aleatorio.
    t.deps.random = (k) => (n++ < 6 ? new Uint8Array(k) : globalThis.crypto.getRandomValues(new Uint8Array(k)));
    const a = await postular({ ...t.deps, random: () => new Uint8Array(4) }, cuerpo({ telefono: '8119998888' }), ctx);
    expect(a.ok && a.value.folio).toBe('369-AAAAAA');
    const b = await postular(t.deps, cuerpo(), ctx);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.folio).not.toBe('369-AAAAAA');
    expect(n).toBeGreaterThan(12);
  });
});

describe('rate limit de códigos (NFR-SEG-03)', () => {
  it('el 4.º código por teléfono en una hora → LIMITE_TELEFONO; a la hora siguiente se permite', async () => {
    for (let i = 0; i < 3; i++) expect((await postular(t.deps, cuerpo(), ctx)).ok).toBe(true);
    expect(await postular(t.deps, cuerpo(), ctx)).toEqual({ ok: false, error: { codigo: 'LIMITE_TELEFONO' } });
    t.clock.advanceMinutes(61);
    expect((await postular(t.deps, cuerpo(), ctx)).ok).toBe(true);
  });
  it('11.º código desde la misma IP → LIMITE_IP', async () => {
    for (let i = 0; i < 10; i++) expect((await postular(t.deps, cuerpo({ telefono: `81100000${String(i).padStart(2, '0')}` }), ctx)).ok).toBe(true);
    expect(await postular(t.deps, cuerpo({ telefono: '8199999999' }), ctx)).toEqual({ ok: false, error: { codigo: 'LIMITE_IP' } });
    expect((await postular(t.deps, cuerpo({ telefono: '8199999999' }), { ...ctx, ip: '10.0.0.1' })).ok).toBe(true);
  });
});

describe('O5 · el código en claro no existe en BD, logs ni respuestas', () => {
  it('solo su hash', async () => {
    const r = await postular(t.deps, cuerpo(), ctx);
    const codigo = t.cifrador.codigos[0]!;
    expect(codigo).toMatch(/^\d{6}$/);
    const volcado = await db.sql.query<{ t: string }>(`
      select string_agg(x::text, '|') as t from (
        select to_jsonb(l) as x from captacion.leads l union all select to_jsonb(o) from captacion.otp o
        union all select to_jsonb(e) from captacion.envios_limitados e union all select to_jsonb(s) from shared.outbox s
        union all select to_jsonb(c) from shared.cola c) q`);
    const texto = volcado.rows[0]!.t;
    // El código puede coincidir por azar con dígitos del teléfono o de un uuid: se busca como token aislado.
    expect(texto).not.toMatch(new RegExp(`(^|[^0-9a-f])${codigo}([^0-9a-f]|$)`));
    expect(t.logs.join('\n')).not.toContain(codigo);
    expect(JSON.stringify(r)).not.toContain(codigo);
    expect(JSON.stringify(t.mensajeria.enviados)).not.toContain(`"${codigo}"`);
  });
  it('los logs no llevan teléfono ni nombre', async () => {
    t.whatsapp.inexistentes.add('528112345678');
    await postular(t.deps, cuerpo(), ctx);
    await postular(t.deps, cuerpo({ telefono: '8100000000' }), ctx);
    const logs = t.logs.join('\n');
    expect(t.logs.length).toBeGreaterThan(0);
    expect(logs).not.toMatch(/8112345678|mariana|189\.203/i);
  });
});
