/**
 * Utilidades Deno de las edge functions, probadas en Node (CONTRATOS regla 6).
 * Cubre: entorno validado (falla al arrancar), servir() con CORS/OPTIONS/correlation_id/500
 * sin filtrar detalles, adaptador SqlClient sobre postgres.js y llaves de rate limit sin PII.
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrorEntorno, leerEntorno, origenesPermitidos } from './env.ts';
import { servir } from './servir.ts';
import { normalizarParametros, sqlClientDesdePostgres, TIPOS_JSON_POSTGRES, type PostgresLike } from './sql.ts';
import { consumirCupo, llaveRateLimit, respuestaLimitada } from './rate-limit.ts';
import type { SqlClient } from '@shared/sql.ts';

const ENTORNO_OK = {
  SUPABASE_DB_URL: 'postgresql://postgres.ref:pw@pooler.supabase.com:6543/postgres',
  HMAC_PEPPER: 'p'.repeat(32),
  OTP_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  LINKS_SECRET: 'l'.repeat(32),
  ALLOWED_ORIGIN: 'https://369capitalhumano.com, https://www.369capitalhumano.com',
  ZOHO_DC: 'com',
  SMTP_PORT: '587',
  EVOLUTION_URL: 'https://evo.example.com',
};

describe('leerEntorno · falla al arrancar si falta un secreto', () => {
  it('devuelve solo las claves pedidas, tipadas y transformadas', () => {
    const env = leerEntorno(['HMAC_PEPPER', 'ALLOWED_ORIGIN', 'SMTP_PORT', 'OTP_ENC_KEY'], ENTORNO_OK);
    expect(env.HMAC_PEPPER).toHaveLength(32);
    expect(env.ALLOWED_ORIGIN).toEqual(['https://369capitalhumano.com', 'https://www.369capitalhumano.com']);
    expect(env.SMTP_PORT).toBe(587);
    expect(Object.keys(env).sort()).toEqual(['ALLOWED_ORIGIN', 'HMAC_PEPPER', 'OTP_ENC_KEY', 'SMTP_PORT']);
  });

  it('lista TODAS las faltantes/invalidas sin exponer valores', () => {
    const fuente = { ...ENTORNO_OK, HMAC_PEPPER: 'corto-secreto', LINKS_SECRET: '', OTP_ENC_KEY: 'no-base64-de-32' };
    let error: unknown;
    try {
      leerEntorno(['HMAC_PEPPER', 'LINKS_SECRET', 'OTP_ENC_KEY', 'META_CAPI_TOKEN'], fuente);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ErrorEntorno);
    const e = error as ErrorEntorno;
    expect(e.claves.sort()).toEqual(['HMAC_PEPPER', 'LINKS_SECRET', 'META_CAPI_TOKEN', 'OTP_ENC_KEY']);
    expect(e.message).not.toContain('corto-secreto');
    expect(e.message).not.toContain('no-base64-de-32');
  });

  it('valida formatos: URL de BD, origen sin barra final, data center de Zoho', () => {
    expect(() => leerEntorno(['SUPABASE_DB_URL'], { SUPABASE_DB_URL: 'mysql://x' })).toThrow(ErrorEntorno);
    expect(() => leerEntorno(['ALLOWED_ORIGIN'], { ALLOWED_ORIGIN: 'https://a.com/' })).toThrow(ErrorEntorno);
    expect(() => leerEntorno(['ALLOWED_ORIGIN'], { ALLOWED_ORIGIN: '*' })).toThrow(ErrorEntorno);
    expect(() => leerEntorno(['ZOHO_DC'], { ZOHO_DC: 'evil.com/x' })).toThrow(ErrorEntorno);
    expect(leerEntorno(['ZOHO_DC'], { ZOHO_DC: 'com.au' }).ZOHO_DC).toBe('com.au');
  });

  it('origenesPermitidos acepta lista separada por comas', () => {
    expect(origenesPermitidos('https://a.com,https://b.com')).toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('servir · CORS, correlation_id y errores sin filtrar detalles', () => {
  const ORIGEN = 'https://369capitalhumano.com';
  const preparar = (manejador: Parameters<typeof servir>[0]) => {
    const lineas: string[] = [];
    const h = servir(manejador, { funcion: 'prueba', origenes: [ORIGEN, 'https://www.369capitalhumano.com'], sink: (l) => lineas.push(l) });
    return { h, lineas };
  };

  it('OPTIONS de un origen permitido → 204 con CORS y sin llamar al handler', async () => {
    const manejador = vi.fn();
    const { h } = preparar(manejador);
    const r = await h(new Request('https://f.supabase.co/x', { method: 'OPTIONS', headers: { origin: 'https://www.369capitalhumano.com' } }));
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://www.369capitalhumano.com');
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
    expect(manejador).not.toHaveBeenCalled();
  });

  it('OPTIONS de un origen no permitido → 403', async () => {
    const { h } = preparar(vi.fn());
    const r = await h(new Request('https://f.supabase.co/x', { method: 'OPTIONS', headers: { origin: 'https://evil.com' } }));
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).not.toBe('https://evil.com');
  });

  it('propaga x-correlation-id válido al handler, a la respuesta y al log; agrega nosniff y no-store', async () => {
    const { h, lineas } = preparar(async (_req, ctx) => {
      ctx.log.info('dentro');
      return new Response(JSON.stringify({ cid: ctx.correlationId }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    const r = await h(new Request('https://f.supabase.co/postular?tel=8112345678', { method: 'POST', headers: { origin: ORIGEN, 'x-correlation-id': 'cid-12345678' } }));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ cid: 'cid-12345678' });
    expect(r.headers.get('x-correlation-id')).toBe('cid-12345678');
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const logs = lineas.map((l) => JSON.parse(l));
    expect(logs.every((l) => l.correlation_id === 'cid-12345678' && l.funcion === 'prueba')).toBe(true);
    expect(logs.at(-1)).toMatchObject({ msg: 'peticion', metodo: 'POST', ruta: '/postular', estado: 201 });
    expect(lineas.join('\n')).not.toContain('8112345678'); // la query string no se registra
  });

  it('genera correlation_id si no viene o es inválido', async () => {
    const { h } = preparar(async (_r, ctx) => new Response(ctx.correlationId));
    const r = await h(new Request('https://f.supabase.co/x', { headers: { 'x-correlation-id': 'mal id con espacios' } }));
    expect(await r.text()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('una excepción → 500 genérico con correlation_id; el detalle va al log redactado', async () => {
    const { h, lineas } = preparar(async () => {
      throw new Error('fallo con ana@x.com y token=abc en tabla citas.citas');
    });
    const r = await h(new Request('https://f.supabase.co/x', { method: 'POST', headers: { origin: ORIGEN } }));
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body).toEqual({ error: 'error_interno', correlation_id: r.headers.get('x-correlation-id') });
    expect(JSON.stringify(body)).not.toMatch(/citas|ana@x\.com|abc/);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    const err = lineas.map((l) => JSON.parse(l)).find((l) => l.nivel === 'error')!;
    expect(err.msg).toBe('error_no_controlado');
    expect(JSON.stringify(err)).not.toContain('ana@x.com');
  });

  it('respeta cache-control propio del handler', async () => {
    const { h } = preparar(async () => new Response('x', { headers: { 'cache-control': 'public, max-age=30' } }));
    expect((await h(new Request('https://f.supabase.co/x'))).headers.get('cache-control')).toBe('public, max-age=30');
  });
});

describe('sqlClientDesdePostgres · implementa SqlClient sobre postgres.js', () => {
  const falso = () => {
    const llamadas: Array<{ nivel: string; q: string; p: unknown[] | undefined }> = [];
    const mk = (nivel: string): PostgresLike => ({
      unsafe: async (q, p) => {
        llamadas.push({ nivel, q, p });
        return [{ n: 1 }];
      },
      begin: async (fn) => fn(mk('tx')),
      savepoint: async (fn) => fn(mk('savepoint')),
    });
    return { pg: mk('raiz'), llamadas };
  };

  it('query → { rows } y normaliza parámetros (objetos a JSON)', async () => {
    const { pg, llamadas } = falso();
    const sql = sqlClientDesdePostgres(pg);
    expect(await sql.query('select $1::jsonb, $2, $3', [{ a: 1 }, 'x', null])).toEqual({ rows: [{ n: 1 }] });
    expect(llamadas[0]).toEqual({ nivel: 'raiz', q: 'select $1::jsonb, $2, $3', p: ['{"a":1}', 'x', null] });
  });

  it('transaction usa begin; transacción anidada usa savepoint', async () => {
    const { pg, llamadas } = falso();
    const sql = sqlClientDesdePostgres(pg);
    const r = await sql.transaction(async (tx) => {
      await tx.query('a');
      return tx.transaction(async (tx2) => {
        await tx2.query('b');
        return 42;
      });
    });
    expect(r).toBe(42);
    expect(llamadas.map((l) => `${l.nivel}:${l.q}`)).toEqual(['tx:a', 'savepoint:b']);
  });

  it('TIPOS_JSON_POSTGRES: json/jsonb no re-serializa cadenas (el JSON ya viene serializado; evita el doble encoding de postgres.js)', () => {
    for (const t of [TIPOS_JSON_POSTGRES.json, TIPOS_JSON_POSTGRES.jsonb]) {
      expect(t.serialize('{"event_id":"x"}')).toBe('{"event_id":"x"}');
      expect(t.serialize({ a: 1 })).toBe('{"a":1}');
      expect(t.parse('{"a":1}')).toEqual({ a: 1 });
    }
    expect(TIPOS_JSON_POSTGRES.json.from).toEqual(expect.arrayContaining([114, 3802]));
    expect(TIPOS_JSON_POSTGRES.jsonb.to).toBe(3802);
  });

  it('normalizarParametros conserva Date, arrays de primitivos, bigint y bytes', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const bytes = new Uint8Array([1]);
    expect(normalizarParametros([d, [1, 2], 5n, bytes, [{ a: 1 }], undefined])).toEqual([d, [1, 2], 5n, bytes, '[{"a":1}]', null]);
  });
});

describe('rate limit genérico', () => {
  it('la llave es un HMAC: no contiene el teléfono ni la IP', async () => {
    const k = await llaveRateLimit('p'.repeat(32), 'otp-telefono', '528112345678');
    expect(k).toMatch(/^otp-telefono:[0-9a-f]{32}$/);
    expect(k).not.toContain('8112345678');
    expect(await llaveRateLimit('p'.repeat(32), 'otp-telefono', '528112345678')).toBe(k);
  });

  it('consumirCupo llama a shared.rate_limit_consumir y calcula reintentarEnSeg', async () => {
    const ahora = new Date('2026-11-13T10:00:20Z');
    const sql: SqlClient = {
      query: vi.fn(async () => ({ rows: [{ permitido: false, conteo: 4, reinicia_en: '2026-11-13T10:01:00Z' }] })) as SqlClient['query'],
      transaction: vi.fn(),
    };
    const r = await consumirCupo(sql, { llave: 'k', limite: 3, ventanaSeg: 60 }, () => ahora);
    expect(r).toEqual({ permitido: false, restantes: 0, reintentarEnSeg: 40 });
    expect(sql.query).toHaveBeenCalledWith('select * from shared.rate_limit_consumir($1, $2, $3)', ['k', 3, 60]);
  });

  it('respuestaLimitada → 429 con Retry-After', async () => {
    const r = respuestaLimitada({ permitido: false, restantes: 0, reintentarEnSeg: 40 });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('40');
    expect(await r.json()).toEqual({ error: 'demasiadas_solicitudes', reintentar_en_seg: 40 });
  });
});
