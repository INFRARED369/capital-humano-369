import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { err, ok } from '@shared/result.ts';
import { crearTestDb, type TestDb } from '../../../../test/db/harness.ts';
import { crearVacante, guardarReglas } from '../../../../test/db/fixtures.ts';
import { cifrarCodigoOtp } from '../domain/otp.ts';
import { encolarMensaje } from './encolar.ts';
import { registrarOptOut } from './privacidad.ts';
import { procesarLote, type DepsWorker } from './worker.ts';
import type { Contacto, ResultadoEnvio, WhatsAppPort, EmailPort } from './puertos.ts';
import { crearReglasVacanteSql } from '../infra/reglas-sql.ts';

const CLAVE = Buffer.alloc(32, 9).toString('base64');
const PEPPER = 'pepper';
const LEAD = '0190d3a0-0000-7000-8000-0000000000b1';
const TEL = '528112345678';

class WhatsAppFalso implements WhatsAppPort {
  readonly proveedor = 'evolution';
  enviados: Array<{ telefonoE164: string; texto: string }> = [];
  fallas: ResultadoEnvio[] = [];
  retraso = 0;
  async enviarTexto(telefonoE164: string, texto: string): Promise<ResultadoEnvio> {
    if (this.retraso) await new Promise((r) => setTimeout(r, this.retraso));
    const f = this.fallas.shift();
    if (f) return f;
    this.enviados.push({ telefonoE164, texto });
    return ok({ proveedorId: `wa-${this.enviados.length}`, costoMxn: 0.35 });
  }
}

class EmailFalso implements EmailPort {
  readonly proveedor = 'smtp';
  enviados: Array<{ para: string; asunto: string; texto: string }> = [];
  async enviar(m: { para: string; asunto: string; texto: string }): Promise<ResultadoEnvio> {
    this.enviados.push(m);
    return ok({ proveedorId: 'smtp-1' });
  }
}

let db: TestDb;
let wa: WhatsAppFalso;
let email: EmailFalso;
let clock: FixedClock;
let logs: string[];
let contactos: Map<string, Contacto>;
let deps: DepsWorker;
let vacanteId: string;
let clienteId: string;

beforeEach(async () => {
  db = await crearTestDb();
  ({ vacanteId, clienteId } = await crearVacante(db.sql));
  wa = new WhatsAppFalso();
  email = new EmailFalso();
  clock = new FixedClock(new Date('2026-11-16T17:00:00Z')); // lunes 11:00 CDMX
  logs = [];
  contactos = new Map([[LEAD, { telefonoE164: TEL, email: 'ana@example.com', nombrePila: 'Ana', folio: 'AS-0001' }]]);
  deps = {
    sql: db.servicio,
    clock,
    canales: { whatsapp: wa, email },
    contactos: { obtener: async (id) => contactos.get(id) ?? null },
    reglas: crearReglasVacanteSql(db.servicio),
    otpKey: CLAVE,
    pepper: PEPPER,
    tarifas: { whatsapp: 0.35, email: 0.01 },
    logger: crearLogger({ fn: 'test' }, (l) => logs.push(l)),
  };
}, 120_000);
afterEach(async () => {
  await db?.close();
});

const solicitud = (over: Record<string, unknown> = {}) => ({
  tipo: 'confirmacion' as const,
  canal: 'whatsapp' as const,
  leadId: LEAD,
  vacanteId,
  clienteId,
  llave: `confirmacion:${Math.random()}`,
  variables: { fecha: 'jueves 19 de noviembre', hora: '11:00', link_cancelar: 'https://x/c', link_reprogramar: 'https://x/r' },
  ...over,
});

/** Hace visible todo lo pendiente (simula el paso del backoff). */
const adelantarCola = () => db.sql.query(`update shared.cola set visible_desde = now() - interval '1 second' where estado = 'pendiente'`);
const mensaje = async (id: string) =>
  (await db.sql.query<Record<string, unknown>>(`select * from comunicacion.mensajes where id = $1`, [id])).rows[0]!;
const eventos = async (tipo: string) => (await db.sql.query<{ payload: Record<string, unknown> }>(`select payload from shared.outbox where tipo = $1 order by id`, [tipo])).rows;

describe('envío feliz', () => {
  it('envía, registra costo por intento, publica MensajeEnviado y no guarda el texto', async () => {
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    const r = await procesarLote(deps);
    expect(r).toMatchObject({ tomados: 1, enviados: 1 });
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0]!.telefonoE164).toBe(TEL);
    expect(wa.enviados[0]!.texto).toContain('Ana');
    expect(wa.enviados[0]!.texto).toContain('AS-0001');
    expect(wa.enviados[0]!.texto).toContain('https://x/c');
    const m = await mensaje(mensajeId);
    expect(m).toMatchObject({ estado: 'enviado', proveedor: 'evolution', proveedor_id: 'wa-1', intentos: 1, variables: null, plantilla: 'confirmacion@defecto' });
    expect(Number(m.costo_mxn)).toBe(0.35);
    const ev = await eventos('MensajeEnviado');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ mensaje_id: mensajeId, canal: 'whatsapp', proveedor: 'evolution', costo_mxn: 0.35, intento: 1, cliente_id: clienteId });
    const cola = await db.sql.query<{ estado: string }>(`select estado from shared.cola`);
    expect(cola.rows[0]!.estado).toBe('completado');
    // ni la BD ni los logs contienen el texto renderizado ni PII
    const dump = JSON.stringify((await db.sql.query(`select * from comunicacion.mensajes`)).rows) + JSON.stringify((await db.sql.query(`select * from comunicacion.intentos`)).rows) + logs.join('\n');
    expect(dump).not.toMatch(/\bAna\b|8112345678|AS-0001|[Ee]ntrevista|ana@example/);
    expect(logs.some((l) => l.includes(mensajeId))).toBe(true);
  });

  it('canal email usa el correo del contacto y el asunto de la plantilla', async () => {
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud({ canal: 'email' }));
    await procesarLote(deps);
    expect(email.enviados).toEqual([expect.objectContaining({ para: 'ana@example.com', asunto: 'Entrevista confirmada · folio AS-0001' })]);
    expect(Number((await mensaje(mensajeId)).costo_mxn)).toBe(0.01);
  });

  it('aviso por correo a un lead sin email → sale por WhatsApp (se registra el canal real)', async () => {
    contactos.set(LEAD, { telefonoE164: TEL, email: null, nombrePila: 'Ana', folio: 'AS-0001' });
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud({ canal: 'email' }));
    await procesarLote(deps);
    expect(email.enviados).toEqual([]);
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'enviado', proveedor: 'evolution' });
    const { rows: [intento] } = await db.sql.query<{ canal: string }>('select canal from comunicacion.intentos where mensaje_id = $1', [mensajeId]);
    expect(intento!.canal).toBe('whatsapp');
    expect(Number((await mensaje(mensajeId)).costo_mxn)).toBe(0.35);
  });

  it('canal sin adaptador configurado (SMS pendiente Q-1) → fallido permanente', async () => {
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud({ canal: 'sms' }));
    const r = await procesarLote(deps);
    expect(r.dead_letter).toBe(1);
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'fallido', motivo: 'CANAL_NO_CONFIGURADO' });
    expect(await eventos('MensajeFallido')).toHaveLength(1);
    expect((await db.sql.query(`select 1 from shared.dead_letter where motivo = 'CANAL_NO_CONFIGURADO'`)).rows).toHaveLength(1);
  });
});

describe('M1/M2 · reintentos', () => {
  it('M1: falla 1 vez → el 2.º intento sale; 2 costos registrados', async () => {
    wa.fallas.push(err({ motivo: 'HTTP_503', permanente: false, costoMxn: 0 }));
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    expect(await procesarLote(deps)).toMatchObject({ reintentos: 1 });
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'reintento', intentos: 1 });
    const backoff = await db.sql.query<{ futuro: boolean }>(`select visible_desde > now() + interval '20 seconds' as futuro from shared.cola`);
    expect(backoff.rows[0]!.futuro).toBe(true);
    expect(await procesarLote(deps)).toMatchObject({ tomados: 0 });
    await adelantarCola();
    expect(await procesarLote(deps)).toMatchObject({ enviados: 1 });
    const intentos = await db.sql.query<{ intento: number; resultado: string }>(`select intento, resultado from comunicacion.intentos order by intento`);
    expect(intentos.rows).toEqual([
      { intento: 1, resultado: 'error' },
      { intento: 2, resultado: 'enviado' },
    ]);
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'enviado', intentos: 2 });
    expect((await eventos('MensajeEnviado'))[0]!.payload).toMatchObject({ intento: 2 });
  });

  it('M2: falla 3 veces → dead letter + MensajeFallido y se borra el OTP cifrado', async () => {
    for (let i = 0; i < 3; i++) wa.fallas.push(err({ motivo: 'TIMEOUT', permanente: false }));
    const cifrado = await cifrarCodigoOtp('123456', CLAVE);
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud({ tipo: 'otp', llave: 'otp:1', codigoCifrado: cifrado, variables: undefined }));
    const resumenes = [];
    for (let i = 0; i < 3; i++) {
      resumenes.push(await procesarLote(deps));
      await adelantarCola();
    }
    expect(resumenes.map((r) => [r.reintentos, r.dead_letter])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'fallido', intentos: 3, codigo_cifrado: null, motivo: 'TIMEOUT' });
    const dl = await db.sql.query<{ payload: unknown }>(`select payload from shared.dead_letter`);
    expect(dl.rows).toEqual([{ payload: { mensaje_id: mensajeId } }]);
    const f = await eventos('MensajeFallido');
    expect(f).toEqual([{ payload: { mensaje_id: mensajeId, canal: 'whatsapp', cliente_id: clienteId, motivo: 'TIMEOUT' } }]);
    expect(await procesarLote(deps)).toMatchObject({ tomados: 0 });
    expect(logs.some((l) => l.includes('"metrica":"comunicacion.dead_letter"'))).toBe(true);
    expect(logs.join('\n')).not.toContain('123456');
  });

  it('error permanente → fallido sin reintentar', async () => {
    wa.fallas.push(err({ motivo: 'HTTP_400', permanente: true }));
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    expect(await procesarLote(deps)).toMatchObject({ dead_letter: 1 });
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'fallido', intentos: 1 });
    // Cierre backend: el permanente queda visible en shared.dead_letter (alertas NFR-OBS-01) vía shared.fallar_definitivo.
    const { rows: dl } = await db.sql.query<{ motivo: string; payload: Record<string, unknown> }>(`select motivo, payload from shared.dead_letter where cola = 'comunicacion'`);
    expect(dl).toEqual([{ motivo: 'HTTP_400', payload: { mensaje_id: mensajeId } }]);
    const { rows: c } = await db.sql.query<{ estado: string }>(`select estado from shared.cola where cola = 'comunicacion'`);
    expect(c).toEqual([{ estado: 'dead_letter' }]);
  });

  it('un adaptador que lanza excepción se trata como error transitorio', async () => {
    const lanza: WhatsAppPort = { proveedor: 'evolution', enviarTexto: async () => { throw new Error('ECONNRESET 8112345678'); } };
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    expect(await procesarLote({ ...deps, canales: { whatsapp: lanza } })).toMatchObject({ reintentos: 1 });
    expect((await mensaje(mensajeId)).motivo).toBe('EXCEPCION');
    expect(logs.join('\n')).not.toContain('8112345678');
  });
});

describe('M3 · idempotencia entre workers', () => {
  it('dos workers concurrentes sobre el mismo mensaje → 1 envío', async () => {
    wa.retraso = 20;
    await encolarMensaje(db.servicio, solicitud({ llave: 'unico' }));
    await encolarMensaje(db.servicio, solicitud({ llave: 'unico' }));
    const [a, b] = await Promise.all([procesarLote(deps), procesarLote(deps)]);
    expect(a.enviados + b.enviados).toBe(1);
    expect(wa.enviados).toHaveLength(1);
  });

  it('si el visibility timeout vence y otro worker lo retoma ya enviado, no se reenvía', async () => {
    await encolarMensaje(db.servicio, solicitud({ llave: 'vt' }));
    await procesarLote(deps);
    // simula que la cola "olvidó" la confirmación (worker caído antes de completar)
    await db.sql.query(`update shared.cola set estado = 'pendiente', visible_desde = now() - interval '1 second'`);
    const r = await procesarLote(deps);
    expect(r).toMatchObject({ tomados: 1, enviados: 0, omitidos: 1 });
    expect(wa.enviados).toHaveLength(1);
  });

  it('un mensaje reclamado por otro worker vigente se deja en paz', async () => {
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    await db.sql.query(`update comunicacion.mensajes set estado = 'enviando', reclamado_hasta = '2099-01-01' where id = $1`, [mensajeId]);
    expect(await procesarLote(deps)).toMatchObject({ tomados: 1, en_curso: 1, enviados: 0 });
  });
});

describe('M4 · opt-out', () => {
  it('teléfono con opt-out → no se envía y queda omitido', async () => {
    await registrarOptOut(db.servicio, { telefonoE164: TEL, clienteId, origen: 'arco' }, PEPPER);
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    expect(await procesarLote(deps)).toMatchObject({ omitidos: 1, enviados: 0 });
    expect(wa.enviados).toHaveLength(0);
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'omitido', motivo: 'OPT_OUT' });
  });

  it('lead suprimido (sin contacto) → no se envía', async () => {
    contactos.clear();
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    await procesarLote(deps);
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'omitido', motivo: 'SIN_CONTACTO' });
  });

  it('mensaje cancelado (M7) → no se envía', async () => {
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud());
    await db.sql.query(`update comunicacion.mensajes set estado = 'cancelado' where id = $1`, [mensajeId]);
    expect(await procesarLote(deps)).toMatchObject({ omitidos: 1 });
    expect(wa.enviados).toHaveLength(0);
  });
});

describe('M6 · ventana horaria', () => {
  it('recordatorio fuera de horario se pospone al inicio de la ventana sin gastar intento', async () => {
    clock.set('2026-11-17T04:00:00Z'); // 22:00 CDMX
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud({ tipo: 'recordatorio_24h', llave: 'r24' }));
    const r = await procesarLote(deps);
    expect(r).toMatchObject({ pospuestos: 1, enviados: 0 });
    expect(wa.enviados).toHaveLength(0);
    const m = await mensaje(mensajeId);
    expect(m).toMatchObject({ estado: 'pendiente', intentos: 0 });
    expect(new Date(m.programado_para as string).toISOString()).toBe('2026-11-17T14:00:00.000Z');
    const cola = await db.sql.query<{ visible_desde: string; estado: string }>(`select visible_desde, estado from shared.cola where estado = 'pendiente'`);
    expect(new Date(cola.rows[0]!.visible_desde).toISOString()).toBe('2026-11-17T14:00:00.000Z');
    clock.set('2026-11-17T14:00:00Z');
    await adelantarCola();
    expect(await procesarLote(deps)).toMatchObject({ enviados: 1 });
  });

  it('el OTP no se pospone de noche', async () => {
    clock.set('2026-11-17T04:00:00Z');
    await encolarMensaje(db.servicio, solicitud({ tipo: 'otp', llave: 'otp:n', variables: undefined, codigoCifrado: await cifrarCodigoOtp('654321', CLAVE) }));
    expect(await procesarLote(deps)).toMatchObject({ enviados: 1 });
    expect(wa.enviados[0]!.texto).toContain('654321');
  });

  it('usa la ventana configurada en la vacante', async () => {
    await guardarReglas(db.sql, vacanteId, { mensajes: { ventana_contacto: { inicio: '12:00', fin: '13:00' } } });
    await encolarMensaje(db.servicio, solicitud({ tipo: 'agradecimiento' }));
    expect(await procesarLote(deps)).toMatchObject({ pospuestos: 1 });
  });
});

describe('M8 · plantilla por vacante', () => {
  it('la vacante B usa su plantilla; la A usa la general', async () => {
    const b = await crearVacante(db.sql, { clienteId, slug: 'vacante-b' });
    await guardarReglas(db.sql, b.vacanteId, { mensajes: { plantillas: { confirmacion: { texto: 'Plantilla B para {{nombre}} folio {{folio}}' } } } });
    await encolarMensaje(db.servicio, solicitud({ vacanteId: b.vacanteId, llave: 'b' }));
    await encolarMensaje(db.servicio, solicitud({ llave: 'a' }));
    await procesarLote(deps);
    const textos = wa.enviados.map((e) => e.texto);
    expect(textos).toContain('Plantilla B para Ana folio AS-0001');
    expect(textos.some((t) => t.startsWith('Hola Ana, tu entrevista quedó confirmada'))).toBe(true);
    const m = await db.sql.query<{ plantilla: string }>(`select plantilla from comunicacion.mensajes where llave = 'b'`);
    expect(m.rows[0]!.plantilla).toBe('confirmacion@vacante:v1');
  });

  it('reglas inválidas en la vacante → plantilla por defecto (no bloquea el envío)', async () => {
    await guardarReglas(db.sql, vacanteId, { mensajes: { canal_preferido: 'paloma' } });
    await encolarMensaje(db.servicio, solicitud());
    expect(await procesarLote(deps)).toMatchObject({ enviados: 1 });
  });

  it('plantilla de vacante con variable que falta → fallido permanente sin envío', async () => {
    await guardarReglas(db.sql, vacanteId, { mensajes: { plantillas: { cancelacion: { texto: 'Cancelada {{fecha}}' } } } });
    const { mensajeId } = await encolarMensaje(db.servicio, solicitud({ tipo: 'cancelacion', variables: undefined }));
    await procesarLote(deps);
    expect(wa.enviados).toHaveLength(0);
    expect(await mensaje(mensajeId)).toMatchObject({ estado: 'fallido', motivo: 'VARIABLE_FALTANTE:fecha' });
  });
});

describe('M9 · prioridad', () => {
  it('OTP en cola junto a 1000 recordatorios → el OTP sale primero', async () => {
    await db.sql.query(
      `insert into comunicacion.mensajes (id, cliente_id, vacante_id, lead_id, tipo, canal, estado, llave, prioridad, programado_para)
       select gen_random_uuid(), $1, $2, $3, 'recordatorio_24h', 'whatsapp', 'pendiente', 'r' || g, 4, now() from generate_series(1, 1000) g`,
      [clienteId, vacanteId, LEAD],
    );
    await db.sql.query(`select shared.encolar('comunicacion', jsonb_build_object('mensaje_id', id), llave, 4::smallint, cliente_id) from comunicacion.mensajes`);
    await encolarMensaje(db.servicio, solicitud({ tipo: 'otp', llave: 'otp:p', variables: undefined, codigoCifrado: await cifrarCodigoOtp('111222', CLAVE) }));
    await procesarLote(deps, { n: 1 });
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0]!.texto).toContain('111222');
  });
});
