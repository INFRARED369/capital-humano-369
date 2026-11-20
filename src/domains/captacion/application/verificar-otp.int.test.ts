/** Integración de `verificarOtp` / `reenviarOtp` (O1–O5, D11). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@shared/ids.ts';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearVacante } from '../../../../test/db/fixtures.ts';
import { crearDepsPrueba } from '../infra/testing/fakes.ts';
import { postular } from './postular.ts';
import { reenviarOtp, verificarOtp } from './verificar-otp.ts';

let db: TestDb;
let t: ReturnType<typeof crearDepsPrueba>;
let leadId: string;
let folio: string;
const ctx = { ip: '189.203.1.2', correlationId: 'corr-2' };

const cuerpo = () => ({
  vacante: 'agente-smart', nombre: 'Luis Pérez', telefono: '8112345678',
  respuestas: { edad: 30, manejo_pc: 'si', papeleria: 'no' }, slot_inicio: '2026-11-17T16:00:00.000Z',
  consentimiento: { aceptado: true, version: '2026-11-13' }, turnstile_token: 'ok', event_id: uuidv7(),
});

beforeEach(async () => {
  db = await crearTestDb();
  await crearVacante(db.sql, { slug: 'agente-smart' });
  t = crearDepsPrueba(db.servicio);
  const r = await postular(t.deps, cuerpo(), ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  leadId = r.value.leadId;
  folio = r.value.folio;
}, 120_000);
afterEach(async () => { await db.close(); });

const codigo = () => t.cifrador.codigos.at(-1)!;
const incorrecto = () => (codigo() === '000000' ? '111111' : '000000');
const verificar = (c: string) => verificarOtp(t.deps, { lead_id: leadId, codigo: c }, ctx);

describe('O1 · código correcto dentro del TTL', () => {
  it('confirma la cita, marca el lead verificado y publica WhatsAppVerificado', async () => {
    t.clock.advanceMinutes(9);
    const r = await verificar(codigo());
    expect(r).toEqual({ ok: true, value: { folio, nombrePila: 'Luis', cita: { id: t.agenda.retenciones[0]!.citaId, inicio: '2026-11-17T16:00:00.000Z', fin: '2026-11-17T17:30:00.000Z' } } });
    expect(t.agenda.confirmaciones).toEqual([expect.objectContaining({ citaId: t.agenda.retenciones[0]!.citaId, folio, nombrePila: 'Luis', eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) })]);
    const { rows: [l] } = await db.sql.query<{ estado: string; verificado_en: string }>('select * from captacion.leads');
    expect(l!.estado).toBe('verificado');
    expect(new Date(l!.verificado_en).toISOString()).toBe('2026-11-16T15:09:00.000Z');
    const { rows: ev } = await db.sql.query<{ payload: Record<string, string> }>(`select payload from shared.outbox where tipo = 'WhatsAppVerificado'`);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ lead_id: leadId, event_id: expect.any(String) });
    expect((await db.sql.query(`select * from captacion.otp where estado = 'verificado'`)).rows).toHaveLength(1);
  });

  it('una segunda verificación → YA_VERIFICADO con el folio', async () => {
    await verificar(codigo());
    expect(await verificar(codigo())).toEqual({ ok: false, error: { codigo: 'YA_VERIFICADO', folio } });
  });

  it('si la retención expiró al confirmar → RETENCION_EXPIRADA y el lead puede volver a postular', async () => {
    t.agenda.errorConfirmar = 'EXPIRADA';
    expect(await verificar(codigo())).toEqual({ ok: false, error: { codigo: 'RETENCION_EXPIRADA' } });
    const { rows: [l] } = await db.sql.query<{ estado: string; cita_id: string | null }>('select * from captacion.leads');
    expect(l).toMatchObject({ estado: 'pendiente_otp', cita_id: null });
    t.agenda.errorConfirmar = null;
    const otra = await postular(t.deps, cuerpo(), ctx);
    expect(otra.ok && otra.value.reutilizado).toBe(true);
    expect((await verificar(codigo())).ok).toBe(true);
  });
});

describe('O2 · 5 intentos incorrectos', () => {
  it('descuenta intentos, bloquea al 5.º y libera la retención; luego ni el correcto pasa', async () => {
    for (const restantes of [4, 3, 2, 1]) expect(await verificar(incorrecto())).toEqual({ ok: false, error: { codigo: 'OTP_INCORRECTO', intentosRestantes: restantes } });
    expect(await verificar(incorrecto())).toEqual({ ok: false, error: { codigo: 'OTP_BLOQUEADO' } });
    expect(t.agenda.liberadas).toEqual([{ citaId: t.agenda.retenciones[0]!.citaId, motivo: 'OTP_BLOQUEADO' }]);
    expect(await verificar(codigo())).toEqual({ ok: false, error: { codigo: 'OTP_BLOQUEADO' } });
    expect(t.agenda.liberadas).toHaveLength(1);
    const { rows: [l] } = await db.sql.query<{ estado: string; cita_id: string | null }>('select * from captacion.leads');
    expect(l).toMatchObject({ estado: 'otp_bloqueado', cita_id: null });
    expect(await reenviarOtp(t.deps, { lead_id: leadId }, ctx)).toEqual({ ok: false, error: { codigo: 'OTP_BLOQUEADO' } });
    expect(t.agenda.confirmaciones).toEqual([]);
  });
});

describe('O3 · código vencido', () => {
  it('error con opción de reenviar; el nuevo código funciona y el viejo no', async () => {
    const viejo = codigo();
    t.clock.advanceMinutes(10);
    expect(await verificar(viejo)).toEqual({ ok: false, error: { codigo: 'OTP_VENCIDO', puedeReenviar: true } });
    t.agenda.expiraExtendida = '2026-11-16T15:20:00.000Z';
    const re = await reenviarOtp(t.deps, { lead_id: leadId }, ctx);
    expect(re).toEqual({ ok: true, value: { expiraEn: '2026-11-16T15:20:00.000Z', reenviosRestantes: 1, canal: 'whatsapp', retencionExpiraEn: '2026-11-16T15:20:00.000Z' } });
    expect(t.agenda.extendidas).toEqual([t.agenda.retenciones[0]!.citaId]);
    const nuevo = codigo();
    expect(t.cifrador.codigos).toHaveLength(2);
    if (nuevo !== viejo) expect(await verificar(viejo)).toMatchObject({ ok: false, error: { codigo: 'OTP_INCORRECTO' } });
    expect((await verificar(nuevo)).ok).toBe(true);
  });
});

describe('reenvío extiende la retención del slot (AgendaPort.extender)', () => {
  it('si la retención ya venció, no se envía código y se pide elegir otro horario', async () => {
    t.agenda.errorExtender = 'EXPIRADA';
    t.clock.advanceMinutes(11);
    expect(await reenviarOtp(t.deps, { lead_id: leadId }, ctx)).toEqual({ ok: false, error: { codigo: 'RETENCION_EXPIRADA' } });
    expect(t.cifrador.codigos).toHaveLength(1);
    expect(t.mensajeria.enviados).toHaveLength(1);
  });
});

describe('O4 · límite de reenvíos', () => {
  it('postular + 2 reenvíos permitidos; el siguiente (4.º código en la hora) → LIMITE_TELEFONO', async () => {
    expect((await reenviarOtp(t.deps, { lead_id: leadId }, ctx)).ok).toBe(true);
    expect((await reenviarOtp(t.deps, { lead_id: leadId }, ctx)).ok).toBe(true);
    expect(await reenviarOtp(t.deps, { lead_id: leadId }, ctx)).toEqual({ ok: false, error: { codigo: 'LIMITE_TELEFONO' } });
    expect(t.mensajeria.enviados).toHaveLength(3);
    expect(new Set(t.mensajeria.enviados.map((m) => m.llave)).size).toBe(3);
    t.clock.advanceMinutes(5);
    expect(await verificar(codigo())).toMatchObject({ ok: true });
  });
  it('un vencido sin cupo de reenvío lo indica', async () => {
    await reenviarOtp(t.deps, { lead_id: leadId }, ctx);
    await reenviarOtp(t.deps, { lead_id: leadId }, ctx);
    t.clock.advanceMinutes(11);
    expect(await verificar(codigo())).toEqual({ ok: false, error: { codigo: 'OTP_VENCIDO', puedeReenviar: false } });
  });
});

describe('reenvío cambiando de canal', () => {
  it('WhatsApp → SMS → correo: cada código nuevo invalida al anterior y comparte el límite', async () => {
    const sms = await reenviarOtp(t.deps, { lead_id: leadId, canal: 'sms' }, ctx);
    expect(sms).toMatchObject({ ok: true, value: { canal: 'sms', reenviosRestantes: 1 } });
    expect(t.mensajeria.enviados.at(-1)).toMatchObject({ tipo: 'otp', canal: 'sms' });
    const viejo = codigo();
    // El lead no dio correo al postular: lo escribe al pedir el código por email.
    expect(await reenviarOtp(t.deps, { lead_id: leadId, canal: 'email' }, ctx)).toEqual({ ok: false, error: { codigo: 'EMAIL_REQUERIDO' } });
    const mail = await reenviarOtp(t.deps, { lead_id: leadId, canal: 'email', email: 'Luis@Correo.MX' }, ctx);
    expect(mail).toMatchObject({ ok: true, value: { canal: 'email', reenviosRestantes: 0 } });
    expect(t.mensajeria.enviados.at(-1)).toMatchObject({ canal: 'email' });
    const { rows: [l] } = await db.sql.query<{ email: string }>('select email from captacion.leads where id = $1', [leadId]);
    expect(l!.email).toBe('luis@correo.mx');
    expect(await verificar(viejo)).toMatchObject({ ok: false });
    expect((await verificar(codigo())).ok).toBe(true);
  });
  it('canal deshabilitado → CANAL_NO_DISPONIBLE sin gastar envío', async () => {
    t.deps.canalesOtp = ['whatsapp', 'email'];
    expect(await reenviarOtp(t.deps, { lead_id: leadId, canal: 'sms' }, ctx)).toEqual({ ok: false, error: { codigo: 'CANAL_NO_DISPONIBLE' } });
    expect(t.mensajeria.enviados).toHaveLength(1);
  });
});

describe('validación y casos borde', () => {
  it('formato inválido, lead inexistente y reenvío a verificado', async () => {
    expect(await verificarOtp(t.deps, { lead_id: leadId, codigo: '12345' }, ctx)).toMatchObject({ ok: false, error: { codigo: 'FORMATO_INVALIDO' } });
    expect(await verificarOtp(t.deps, { lead_id: leadId, codigo: '123456', extra: 1 }, ctx)).toMatchObject({ ok: false, error: { codigo: 'FORMATO_INVALIDO' } });
    expect(await verificarOtp(t.deps, { lead_id: globalThis.crypto.randomUUID(), codigo: '123456' }, ctx)).toEqual({ ok: false, error: { codigo: 'NO_ENCONTRADO' } });
    expect(await reenviarOtp(t.deps, { lead_id: 'x' }, ctx)).toMatchObject({ ok: false, error: { codigo: 'FORMATO_INVALIDO' } });
    expect(await reenviarOtp(t.deps, { lead_id: globalThis.crypto.randomUUID() }, ctx)).toEqual({ ok: false, error: { codigo: 'NO_ENCONTRADO' } });
    await verificar(codigo());
    expect(await reenviarOtp(t.deps, { lead_id: leadId }, ctx)).toEqual({ ok: false, error: { codigo: 'YA_VERIFICADO', folio } });
  });
  it('lead sin OTP (suprimido el OTP) → NO_ENCONTRADO', async () => {
    await db.sql.query('delete from captacion.otp');
    expect(await verificar('123456')).toEqual({ ok: false, error: { codigo: 'NO_ENCONTRADO' } });
  });
  it('lead sin retención activa al verificar → RETENCION_EXPIRADA', async () => {
    await db.sql.query('update captacion.leads set cita_id = null');
    expect(await verificar(codigo())).toEqual({ ok: false, error: { codigo: 'RETENCION_EXPIRADA' } });
  });
  it('O5 · el código no aparece en logs', async () => {
    await verificar(incorrecto());
    await verificar(codigo());
    expect(t.logs.join('\n')).not.toContain(codigo());
  });
});
