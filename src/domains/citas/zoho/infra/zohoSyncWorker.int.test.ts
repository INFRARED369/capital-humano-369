/**
 * zoho-sync-worker contra PGlite (migraciones reales) + calendario falso.
 * Trazabilidad: Z1, Z2, Z3, Z4, Z6 (a nivel worker), Z7 · CIT-08 · NFR-DISP-01.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearTestDb, type TestDb } from '@test/db/harness';
import { crearVacante, guardarReglas } from '@test/db/fixtures';
import { construirEventoMinimo } from '../domain/evento.ts';
import { CalendarioFalso } from '../testing/calendarioFalso.ts';
import { ejecutarWorkerZoho } from '../application/worker.ts';
import { crearDepsZohoSql } from './sqlZoho.ts';

const CAL = 'c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
const PANEL = 'https://panel.369.mx';
let db: TestDb;
let zoho: CalendarioFalso;
let logs: string[];
let vac: { vacanteId: string; clienteId: string };

const uuid = () => globalThis.crypto.randomUUID();
const enHoras = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function deps() {
  return crearDepsZohoSql({
    sql: db.servicio,
    calendario: zoho,
    clock: new FixedClock(new Date()),
    logger: crearLogger({ fn: 'zoho-sync-worker' }, (l) => logs.push(l)),
    panelUrl: PANEL,
    zonaHoraria: 'America/Mexico_City',
  });
}
const correr = () => ejecutarWorkerZoho(deps(), { lote: 20 });

async function publicar(tipo: string, payload: Record<string, unknown>) {
  await db.sql.query(`select shared.publicar_evento($1, $2::jsonb, $3)`, [tipo, JSON.stringify(payload), vac.clienteId]);
}

function confirmada(over: Partial<Record<string, unknown>> = {}) {
  const citaId = uuid();
  return {
    cita_id: citaId, lead_id: uuid(), vacante_id: vac.vacanteId, cliente_id: vac.clienteId,
    inicio: enHoras(48), fin: enHoras(48.5), folio: 'V-0042', nombre_pila: 'María', reglas_version: 1, event_id: uuid(), ...over,
  };
}

async function registro(citaId: string) {
  const { rows } = await db.sql.query<Record<string, unknown>>('select * from citas.zoho_eventos where cita_id = $1', [citaId]);
  return rows[0];
}
async function alertas(tipo?: string) {
  const { rows } = await db.sql.query<{ tipo: string; cita_id: string | null; detalle: Record<string, unknown> }>(
    `select tipo, cita_id, detalle from citas.zoho_alertas ${tipo ? 'where tipo = $1' : ''} order by id`, tipo ? [tipo] : [],
  );
  return rows;
}
const hacerVisibles = () => db.sql.query(`update shared.cola set visible_desde = now() where cola = 'zoho-sync'`);

beforeEach(async () => {
  db = await crearTestDb();
  zoho = new CalendarioFalso();
  logs = [];
  vac = await crearVacante(db.sql);
  await guardarReglas(db.sql, vac.vacanteId, { zoho_calendar_uid: CAL });
}, 60_000);
afterEach(async () => { await db.close(); });

describe('Z1 · CitaConfirmada → evento mínimo en el calendario de la vacante', () => {
  it('crea el evento sin teléfono ni asistentes y guarda zoho_event_uid', async () => {
    const p = confirmada();
    await publicar('CitaConfirmada', p);
    const r = await correr();
    expect(r).toMatchObject({ ingeridos: 1, completados: 1, reintentos: 0, deadLetters: 0 });

    const [ev] = zoho.eventos(CAL);
    expect(zoho.eventos(CAL)).toHaveLength(1);
    expect(ev!.titulo).toBe('Entrevista V-0042 · María');
    expect(ev!.descripcion).toContain(`${PANEL}/panel/citas/?id=${p.cita_id}`);
    expect(ev!.numAsistentes).toBe(0);
    expect(Date.parse(ev!.inicio)).toBe(Date.parse(p.inicio));

    const reg = await registro(p.cita_id);
    expect(reg).toMatchObject({ estado_sync: 'sincronizado', zoho_event_uid: ev!.uid, zoho_calendar_uid: CAL, vigente: true, uid_propio: `cita-${p.cita_id}` });
  });

  it('el log del worker no contiene el nombre de pila', async () => {
    await publicar('CitaConfirmada', confirmada({ nombre_pila: 'Eustaquio' }));
    await correr();
    expect(logs.join('\n')).not.toContain('Eustaquio');
  });
});

describe('Z2 · idempotencia', () => {
  it('correr el worker dos veces no duplica', async () => {
    await publicar('CitaConfirmada', confirmada());
    await correr();
    await correr();
    expect(zoho.eventos(CAL)).toHaveLength(1);
    expect(zoho.llamadas.filter((c) => c === 'crear')).toHaveLength(1);
  });

  it('el mismo mensaje del outbox entregado 2 veces → 1 trabajo y 1 evento', async () => {
    await publicar('CitaConfirmada', confirmada());
    await correr();
    await db.sql.query(`update shared.outbox_consumidores set ultimo_id = 0 where consumidor = 'zoho-sync'`);
    await db.sql.query(`update shared.cola set estado = 'pendiente', visible_desde = now() where cola = 'zoho-sync'`);
    await correr();
    const { rows } = await db.sql.query(`select * from shared.cola where cola = 'zoho-sync'`);
    expect(rows).toHaveLength(1);
    expect(zoho.eventos(CAL)).toHaveLength(1);
  });

  it('si el worker cayó tras crear en Zoho sin guardar el uid, adopta el evento por UID propio', async () => {
    const p = confirmada();
    const previo = construirEventoMinimo({ citaId: p.cita_id, folio: p.folio, nombrePila: p.nombre_pila, inicio: p.inicio, fin: p.fin }, { panelUrl: PANEL, zonaHoraria: 'America/Mexico_City' });
    if (!previo.ok) throw new Error();
    const sembrado = zoho.sembrar(CAL, previo.value);
    await publicar('CitaConfirmada', p);
    await correr();
    expect(zoho.eventos(CAL)).toHaveLength(1);
    expect(zoho.llamadas).not.toContain('crear');
    expect((await registro(p.cita_id))!.zoho_event_uid).toBe(sembrado.uid);
  });
});

describe('Z3 · Zoho caído: reintentos y dead letter; la cita sigue confirmada', () => {
  it('500 tres veces → dead letter + alerta ZOHO_DEAD_LETTER; el registro sigue vigente', async () => {
    const p = confirmada();
    zoho.fallarProximas(3, { tipo: 'transitorio', status: 500, mensaje: 'HTTP 500' }, 'listar');
    await publicar('CitaConfirmada', p);

    const r1 = await correr();
    expect(r1).toMatchObject({ reintentos: 1, deadLetters: 0 });
    const { rows: [c] } = await db.sql.query<{ visible: boolean; intentos: number }>(`select visible_desde > now() + interval '20 seconds' as visible, intentos from shared.cola where cola = 'zoho-sync'`);
    expect(c).toEqual({ visible: true, intentos: 1 }); // backoff aplicado

    await hacerVisibles();
    expect(await correr()).toMatchObject({ reintentos: 1, deadLetters: 0 });
    await hacerVisibles();
    expect(await correr()).toMatchObject({ reintentos: 0, deadLetters: 1 });

    const { rows: dl } = await db.sql.query(`select * from shared.dead_letter where cola = 'zoho-sync'`);
    expect(dl).toHaveLength(1);
    expect(await alertas('ZOHO_DEAD_LETTER')).toEqual([expect.objectContaining({ cita_id: p.cita_id })]);
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'error', vigente: true, intentos: 3 });
    const { rows: canc } = await db.sql.query(`select * from shared.outbox where tipo = 'CitaCancelada'`);
    expect(canc).toEqual([]);
    expect(zoho.eventos(CAL)).toEqual([]);
  });

  it('una falla transitoria y luego éxito → sincronizado', async () => {
    zoho.fallarProximas(1, { tipo: 'transitorio', status: 503, mensaje: 'HTTP 503' });
    const p = confirmada();
    await publicar('CitaConfirmada', p);
    await correr();
    await hacerVisibles();
    await correr();
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'sincronizado' });
    expect(zoho.eventos(CAL)).toHaveLength(1);
  });

  it('4xx permanente (400) → dead letter en el 1.er intento (shared.fallar_definitivo) + ZOHO_DEAD_LETTER, sin backoff', async () => {
    const p = confirmada();
    zoho.fallarProximas(1, { tipo: 'permanente', status: 400, mensaje: 'HTTP 400 INVALID_DATA' }, 'listar');
    await publicar('CitaConfirmada', p);
    expect(await correr()).toMatchObject({ reintentos: 0, deadLetters: 1 });
    const { rows: cola } = await db.sql.query<{ estado: string; intentos: number }>(`select estado, intentos from shared.cola where cola = 'zoho-sync'`);
    expect(cola).toEqual([{ estado: 'dead_letter', intentos: 1 }]);
    const { rows: dl } = await db.sql.query<{ motivo: string }>(`select motivo from shared.dead_letter where cola = 'zoho-sync'`);
    expect(dl).toEqual([{ motivo: expect.stringContaining('permanente 400') }]);
    expect(await alertas('ZOHO_DEAD_LETTER')).toEqual([expect.objectContaining({ cita_id: p.cita_id })]);
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'error', vigente: true });
  });

  it('Z6 · error de auth persistente → alerta ZOHO_AUTH', async () => {
    zoho.fallarProximas(1, { tipo: 'auth', status: 401, mensaje: 'token inválido tras renovar' });
    await publicar('CitaConfirmada', confirmada());
    await correr();
    expect(await alertas('ZOHO_AUTH')).toHaveLength(1);
  });
});

describe('Z4 · reprogramación y cancelación', () => {
  it('CitaReprogramada → se actualiza el MISMO evento (horario y link) y no se duplica', async () => {
    const p = confirmada();
    await publicar('CitaConfirmada', p);
    await correr();
    const [antes] = zoho.eventos(CAL);

    const nueva = uuid();
    const nuevoInicio = enHoras(72);
    await publicar('CitaReprogramada', {
      cita_id: nueva, cita_anterior_id: p.cita_id, lead_id: p.lead_id, vacante_id: vac.vacanteId, cliente_id: vac.clienteId,
      inicio: nuevoInicio, fin: enHoras(72.5), folio: p.folio, nombre_pila: p.nombre_pila,
    });
    await correr();

    const eventos = zoho.eventos(CAL);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.uid).toBe(antes!.uid);
    expect(eventos[0]!.descripcion).toContain(`/panel/citas/?id=${nueva}`);
    expect(Date.parse(eventos[0]!.inicio)).toBe(Date.parse(nuevoInicio));
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'reemplazado', vigente: false, zoho_event_uid: null });
    expect(await registro(nueva)).toMatchObject({ estado_sync: 'sincronizado', zoho_event_uid: antes!.uid, vigente: true });
  });

  it('CitaCancelada → se borra el evento', async () => {
    const p = confirmada();
    await publicar('CitaConfirmada', p);
    await correr();
    await publicar('CitaCancelada', { cita_id: p.cita_id, lead_id: p.lead_id, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, motivo: 'candidato' });
    await correr();
    expect(zoho.eventos(CAL)).toEqual([]);
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'borrado', vigente: false });
  });

  it('confirmada y cancelada antes de sincronizar → nunca aparece en Zoho', async () => {
    const p = confirmada();
    await publicar('CitaConfirmada', p);
    await publicar('CitaCancelada', { cita_id: p.cita_id, lead_id: p.lead_id, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, motivo: 'x' });
    await correr();
    expect(zoho.eventos(CAL)).toEqual([]);
    expect(zoho.llamadas).not.toContain('crear');
  });

  it('el evento editado en Zoho antes de cancelar (etag nuevo) igual se borra', async () => {
    const p = confirmada();
    await publicar('CitaConfirmada', p);
    await correr();
    zoho.editarAMano(CAL, zoho.eventos(CAL)[0]!.uid, { titulo: 'editado' });
    await publicar('CitaCancelada', { cita_id: p.cita_id, lead_id: p.lead_id, vacante_id: vac.vacanteId, cliente_id: vac.clienteId, motivo: 'x' });
    await correr();
    expect(zoho.eventos(CAL)).toEqual([]);
  });

  it('cancelación de una cita que el worker no conoce → se ignora sin fallar', async () => {
    await publicar('CitaCancelada', { cita_id: uuid(), lead_id: uuid(), vacante_id: vac.vacanteId, cliente_id: vac.clienteId, motivo: 'x' });
    expect(await correr()).toMatchObject({ ingeridos: 1, completados: 0, deadLetters: 0 });
  });
});

describe('Z7 · vacante sin zoho_calendar_uid', () => {
  it('no falla: registra sin_calendario, alerta de configuración incompleta y no encola', async () => {
    const otra = await crearVacante(db.sql, { clienteId: vac.clienteId });
    const p = confirmada({ vacante_id: otra.vacanteId });
    await publicar('CitaConfirmada', p);
    const r = await correr();
    expect(r).toMatchObject({ ingeridos: 1, completados: 0, deadLetters: 0 });
    expect(await registro(p.cita_id)).toMatchObject({ estado_sync: 'sin_calendario', vigente: true });
    expect(await alertas('ZOHO_CONFIG_INCOMPLETA')).toEqual([expect.objectContaining({ cita_id: p.cita_id })]);
    const { rows } = await db.sql.query(`select * from shared.cola where cola = 'zoho-sync'`);
    expect(rows).toEqual([]);
    const { rows: [cur] } = await db.sql.query<{ ultimo_id: string }>(`select ultimo_id from shared.outbox_consumidores where consumidor = 'zoho-sync'`);
    expect(Number(cur!.ultimo_id)).toBeGreaterThan(0);
  });

  it('un zoho_calendar_uid con caracteres inválidos se trata como configuración incompleta', async () => {
    const otra = await crearVacante(db.sql, { clienteId: vac.clienteId });
    await guardarReglas(db.sql, otra.vacanteId, { zoho_calendar_uid: '../../admin' });
    await publicar('CitaConfirmada', confirmada({ vacante_id: otra.vacanteId }));
    await correr();
    expect(await alertas('ZOHO_CONFIG_INCOMPLETA')).toHaveLength(1);
    expect(zoho.llamadas).toEqual([]);
  });
});

describe('robustez de la ingesta', () => {
  it('payload inválido se descarta con log y el cursor avanza', async () => {
    await publicar('CitaConfirmada', { cita_id: 'no-uuid' });
    await publicar('CitaConfirmada', confirmada());
    const r = await correr();
    expect(r).toMatchObject({ ingeridos: 2, descartados: 1, completados: 1 });
  });

  it('folio con posible teléfono → no se publica nada en Zoho (error permanente)', async () => {
    const p = confirmada({ folio: '5512345678' });
    await publicar('CitaConfirmada', p);
    await correr();
    expect(zoho.llamadas).not.toContain('crear');
    expect(logs.join('\n')).not.toContain('5512345678');
    const { rows } = await db.sql.query<{ estado: string; intentos: number }>(`select estado, intentos from shared.cola where cola = 'zoho-sync'`);
    expect(rows).toEqual([{ estado: 'dead_letter', intentos: 1 }]);
  });
});
