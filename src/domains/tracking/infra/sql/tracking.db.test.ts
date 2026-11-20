import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearTestDb, type TestDb } from '../../../../../test/db/harness.ts';
import { crearUsuario, crearVacante } from '../../../../../test/db/fixtures.ts';
import { truncarIp } from '../../domain/ip.ts';

let db: TestDb;
beforeEach(async () => { db = await crearTestDb(); }, 60_000);
afterEach(async () => { await db.close(); });

const evento = (extra: Record<string, unknown> = {}) => ({
  event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e',
  nombre: 'PageView', fuente: 'navegador', consentimiento: true,
  visitor_id: '01934f6e-0000-7000-8000-000000000001', origen: 'meta_pagado',
  utm_source: 'facebook', utm_campaign: 'nov', ip: '189.203.1.2', user_agent: 'UA', ciudad: 'Monterrey',
  pagina: '/vacantes/agente-smart/', propiedades: {}, ...extra,
});

const registrar = (sql = db.servicio, e: Record<string, unknown> = evento(), destinos = ['meta', 'ga4']) =>
  sql.query<{ r: { duplicado: boolean } }>('select tracking.registrar_evento($1::jsonb, $2::text[]) as r', [JSON.stringify(e), destinos]).then((x) => x.rows[0]!.r);

describe('NFR-ESC-03 · tracking.eventos particionada por mes', () => {
  it('es una tabla particionada con partición del mes actual, siguientes y default', async () => {
    const { rows: [t] } = await db.sql.query<{ relkind: string }>(`select relkind from pg_class where oid = 'tracking.eventos'::regclass`);
    expect(t!.relkind).toBe('p');
    const { rows } = await db.sql.query<{ n: string }>(`select c.relname as n from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'tracking.eventos'::regclass`);
    const nombres = rows.map((r) => r.n);
    const ahora = new Date();
    const mes = (d: Date) => `eventos_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(nombres).toContain(mes(ahora));
    expect(nombres).toContain(mes(new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1))));
    expect(nombres).toContain('eventos_default');
  });

  it('crear_particiones es idempotente y mueve filas del default al crear el mes', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    await registrar(db.sql, evento({ vacante_ref: vacanteId, creado_en: '2031-05-10T00:00:00Z' }));
    const { rows: [a] } = await db.sql.query<{ n: number }>(`select tracking.crear_particiones('2031-05-01', 2) as n`);
    const { rows: [b] } = await db.sql.query<{ n: number }>(`select tracking.crear_particiones('2031-05-01', 2) as n`);
    expect(a!.n).toBe(2);
    expect(b!.n).toBe(0);
    const { rows } = await db.sql.query<{ t: string }>(`select tableoid::regclass::text as t from tracking.eventos`);
    expect(rows).toEqual([{ t: 'tracking.eventos_2031_05' }]);
  });
});

describe('T3 · event_id repetido → 1 fila y 1 envío', () => {
  it('registra una sola vez y encola un solo mensaje por destino', async () => {
    expect(await registrar()).toMatchObject({ duplicado: false });
    expect(await registrar()).toMatchObject({ duplicado: true });
    const { rows: ev } = await db.sql.query(`select * from tracking.eventos`);
    expect(ev).toHaveLength(1);
    const { rows: cola } = await db.sql.query<{ llave_idempotencia: string; payload: Record<string, string> }>(`select llave_idempotencia, payload from shared.cola where cola = 'tracking-capi' order by id`);
    expect(cola.map((c) => c.llave_idempotencia)).toEqual(['meta:01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e', 'ga4:01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e']);
    expect(Object.keys(cola[0]!.payload).sort()).toEqual(['creado_en', 'destino', 'event_id']); // sin PII en la cola
  });

  it('shared.api_vacante_por_slug: por slug, id o código → vacante y cliente reales; solo service_role', async () => {
    const v = await crearVacante(db.sql, { slug: 'agente-smart' });
    const { rows: [cod] } = await db.sql.query<{ codigo: string }>('select codigo from shared.vacantes where id = $1', [v.vacanteId]);
    for (const ref of ['agente-smart', v.vacanteId, cod!.codigo]) {
      const { rows } = await db.servicio.query<{ vacante_id: string; cliente_id: string; slug: string }>('select * from shared.api_vacante_por_slug($1)', [ref]);
      expect(rows, ref).toEqual([{ vacante_id: v.vacanteId, cliente_id: v.clienteId, slug: 'agente-smart' }]);
    }
    expect((await db.servicio.query('select * from shared.api_vacante_por_slug($1)', ['telecom-mty'])).rows).toEqual([]);
    expect((await db.servicio.query('select * from shared.api_vacante_por_slug(null)')).rows).toEqual([]);
    const { rows: [p] } = await db.sql.query<{ anon: boolean; auth: boolean }>(
      `select has_function_privilege('anon', 'shared.api_vacante_por_slug(text)', 'execute') as anon, has_function_privilege('authenticated', 'shared.api_vacante_por_slug(text)', 'execute') as auth`);
    expect(p).toEqual({ anon: false, auth: false });
  });

  it('resuelve vacante por slug y toma su cliente (ignora el client_id del navegador)', async () => {
    const { vacanteId, clienteId } = await crearVacante(db.sql, { slug: 'agente-smart' });
    await registrar(db.servicio, evento({ vacante_ref: 'agente-smart', cliente_ref: '0b6f2c1e-6a43-4d34-9b8e-6d7c3a2f1e00' }));
    const { rows: [e] } = await db.sql.query<{ vacante_id: string; cliente_id: string }>(`select vacante_id, cliente_id from tracking.eventos`);
    expect(e).toEqual({ vacante_id: vacanteId, cliente_id: clienteId });
  });

  it('sin vacante conocida usa el cliente indicado si existe; si no, el cliente nulo del proyecto', async () => {
    await registrar(db.servicio, evento({ vacante_ref: 'no-existe' }));
    const { rows: [e] } = await db.sql.query<{ vacante_id: string | null; cliente_id: string }>(`select vacante_id, cliente_id from tracking.eventos`);
    expect(e).toEqual({ vacante_id: null, cliente_id: '00000000-0000-0000-0000-000000000000' });
  });
});

describe('conteo técnico sin consentimiento', () => {
  it('suma en agregados_diarios sin IP, visitor ni event_id', async () => {
    const { vacanteId } = await crearVacante(db.sql, { slug: 'x1' });
    for (let i = 0; i < 2; i++) {
      await db.servicio.query(`select tracking.contar_anonimo($1::jsonb)`, [JSON.stringify({ nombre: 'PageView', vacante_ref: 'x1', origen: 'directo', utm_source: null, utm_campaign: null })]);
    }
    const { rows } = await db.sql.query(`select vacante_id, nombre, consentimiento, n::int as n from tracking.agregados_diarios`);
    expect(rows).toEqual([{ vacante_id: vacanteId, nombre: 'PageView', consentimiento: false, n: 2 }]);
    const { rows: ev } = await db.sql.query(`select 1 from tracking.eventos`);
    expect(ev).toHaveLength(0);
  });
});

describe('RLS y vista del funnel', () => {
  it('anon no puede ejecutar funciones de tracking ni leer tablas', async () => {
    await expect(db.como('anon', null, (s) => s.query(`select tracking.registrar_evento('{}'::jsonb, '{}')`))).rejects.toThrow(/permission denied/);
    await expect(db.como('anon', null, (s) => s.query(`select * from tracking.api_funnel_diario`))).rejects.toThrow(/permission denied/);
  });

  it('el panel lee el funnel solo de sus vacantes y nunca la IP', async () => {
    const a = await crearVacante(db.sql, { slug: 'va' });
    const b = await crearVacante(db.sql, { slug: 'vb' });
    await registrar(db.servicio, evento({ vacante_ref: a.vacanteId }));
    await registrar(db.servicio, evento({ vacante_ref: b.vacanteId, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0f' }));
    await db.servicio.query(`select tracking.contar_anonimo($1::jsonb)`, [JSON.stringify({ nombre: 'PageView', vacante_ref: a.vacanteId, origen: 'directo' })]);
    const reclutador = await crearUsuario(db.sql, 'reclutador', { clienteId: a.clienteId, vacantes: [a.vacanteId] });
    const filas = await db.comoUsuario(reclutador, (s) => s.query<{ vacante_id: string; origen: string; eventos: number }>(`select vacante_id, origen, evento, eventos::int as eventos from tracking.api_funnel_diario order by origen`));
    expect(filas.rows).toEqual([
      { vacante_id: a.vacanteId, origen: 'directo', evento: 'PageView', eventos: 1 },
      { vacante_id: a.vacanteId, origen: 'meta_pagado', evento: 'PageView', eventos: 1 },
    ]);
    await expect(db.comoUsuario(reclutador, (s) => s.query(`select ip from tracking.eventos`))).rejects.toThrow(/permission denied/);
    const visibles = await db.comoUsuario(reclutador, (s) => s.query(`select event_id from tracking.eventos`));
    expect(visibles.rows).toHaveLength(1);
  });
});

describe('Privacidad (R4, R5, supresión)', () => {
  const ahora = '2026-11-13T12:00:00Z';

  it('R5 · IP de hace 8 días se trunca (IPv4 /24, IPv6 /48) igual que el dominio', async () => {
    await registrar(db.sql, evento({ creado_en: '2026-11-05T11:00:00Z' }));
    await registrar(db.sql, evento({ event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d01', ip: '2806:2f0:9020:abcd::1', creado_en: '2026-11-05T11:00:00Z' }));
    await registrar(db.sql, evento({ event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d02', creado_en: '2026-11-10T11:00:00Z' }));
    const { rows: [r] } = await db.sql.query<{ r: Record<string, number> }>(`select tracking.retencion_aplicar($1) as r`, [ahora]);
    expect(r!.r.R5_ips_truncadas).toBe(2);
    const { rows } = await db.sql.query<{ ip: string }>(`select host(ip) as ip from tracking.eventos order by creado_en desc, family(ip)`);
    expect(rows.map((x) => x.ip)).toEqual(['189.203.1.2', truncarIp('189.203.1.2'), truncarIp('2806:2f0:9020:abcd::1')]);
    const { rows: [again] } = await db.sql.query<{ r: Record<string, number> }>(`select tracking.retencion_aplicar($1) as r`, [ahora]);
    expect(again!.r.R5_ips_truncadas).toBe(0);
  });

  it('R4 · evento de hace 91 días: se borra el crudo y el agregado coincide', async () => {
    const { vacanteId } = await crearVacante(db.sql);
    for (let i = 0; i < 3; i++) {
      await registrar(db.sql, evento({ event_id: `01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d1${i}`, vacante_ref: vacanteId, creado_en: '2026-08-14T15:00:00Z' }));
    }
    await registrar(db.sql, evento({ event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d20', vacante_ref: vacanteId, creado_en: '2026-10-01T15:00:00Z' }));
    const antes = await db.sql.query<{ eventos: number }>(`select sum(eventos)::int as eventos from tracking.api_funnel_diario`);
    const { rows: [r] } = await db.sql.query<{ r: Record<string, number> }>(`select tracking.retencion_aplicar($1) as r`, [ahora]);
    expect(r!.r.R4_eventos_agregados).toBe(3);
    const crudos = await db.sql.query(`select 1 from tracking.eventos`);
    expect(crudos.rows).toHaveLength(1);
    const ids = await db.sql.query(`select 1 from tracking.eventos_ids`);
    expect(ids.rows).toHaveLength(1);
    const despues = await db.sql.query<{ eventos: number }>(`select sum(eventos)::int as eventos from tracking.api_funnel_diario`);
    expect(despues.rows).toEqual(antes.rows);
    const { rows: agg } = await db.sql.query(`select dia::text, origen, utm_campaign, nombre, consentimiento, n::int as n from tracking.agregados_diarios`);
    expect(agg).toEqual([{ dia: '2026-08-14', origen: 'meta_pagado', utm_campaign: 'nov', nombre: 'PageView', consentimiento: true, n: 3 }]);
    const { rows: [r2] } = await db.sql.query<{ r: Record<string, number> }>(`select tracking.retencion_aplicar($1) as r`, [ahora]);
    expect(r2!.r.R4_eventos_agregados).toBe(0);
  });

  it('suprimir_lead borra los eventos del lead y de su visitante (conteos intactos) y es idempotente', async () => {
    const lead = '01934f6e-aaaa-7000-8000-000000000001';
    await db.sql.query(`select tracking.registrar_lead($1::jsonb)`, [JSON.stringify({ lead_id: lead, visitor_id: evento().visitor_id, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d99', origen: 'meta_pagado' })]);
    await registrar(db.sql, evento());
    await registrar(db.sql, evento({ event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d99', nombre: 'LeadCreado', fuente: 'servidor', lead_id: lead, ip: null }));
    await registrar(db.sql, evento({ event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d98', visitor_id: '01934f6e-0000-7000-8000-000000000002' }));
    const { rows: [r] } = await db.sql.query<{ r: Record<string, number> }>(`select tracking.suprimir_lead($1) as r`, [lead]);
    expect(r!.r).toEqual({ eventos: 2, leads: 1 });
    const { rows } = await db.sql.query<{ visitor_id: string }>(`select visitor_id from tracking.eventos`);
    expect(rows).toEqual([{ visitor_id: '01934f6e-0000-7000-8000-000000000002' }]);
    const total = await db.sql.query<{ n: number }>(`select sum(eventos)::int as n from tracking.api_funnel_diario`);
    expect(total.rows[0]!.n).toBe(3);
    const { rows: [r2] } = await db.sql.query<{ r: Record<string, number> }>(`select tracking.suprimir_lead($1) as r`, [lead]);
    expect(r2!.r).toEqual({ eventos: 0, leads: 0 });
  });
});
