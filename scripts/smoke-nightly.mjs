#!/usr/bin/env node
/**
 * Smoke nightly contra STAGING (§3.1). Corre en .github/workflows/nightly.yml (cron diario + manual, environment
 * staging) y localmente con las mismas variables:
 *   1. Zoho Calendar: OAuth refresh → crear evento mínimo en un calendario de PRUEBA → obtenerlo → borrarlo.
 *      Usa el adaptador del dominio (src/domains/citas/zoho/index.ts), que valida cada respuesta con los
 *      esquemas Zod del contrato (token, eventos): una respuesta fuera de contrato falla el smoke.
 *   2. Evolution: existeEnWhatsApp(SMOKE_TELEFONO_PRUEBA) + envío de un OTP de prueba.
 *   3. GET citas-api (forma de la respuesta, con agenda_modo) y GET tracking-ingest (vivo: 405 a GET, no 5xx).
 * Sale con 1 si algo falla, 2 si falta configuración. No imprime secretos ni el teléfono.
 *
 *   node scripts/smoke-nightly.mjs     (lee ZOHO_*, EVOLUTION_*, SMOKE_TELEFONO_PRUEBA, STAGING_*)
 */
import { randomInt, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const REQUERIDAS = [
  'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_CALENDARIO_PRUEBA',
  'EVOLUTION_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'SMOKE_TELEFONO_PRUEBA',
  'STAGING_FUNCIONES_URL', 'STAGING_URL',
];

/** @typedef {ReturnType<typeof leerConfig>['cfg']} ConfigSmoke */
export function leerConfig(env) {
  const v = (k) => (env[k] ?? '').trim();
  const faltan = REQUERIDAS.filter((k) => !v(k));
  const digitos = v('SMOKE_TELEFONO_PRUEBA').replace(/\D/g, '');
  return {
    faltan,
    cfg: {
      zoho: { dc: v('ZOHO_DC') || 'com', clientId: v('ZOHO_CLIENT_ID'), clientSecret: v('ZOHO_CLIENT_SECRET'), refreshToken: v('ZOHO_REFRESH_TOKEN') },
      calendario: v('ZOHO_CALENDARIO_PRUEBA'),
      evolution: { url: v('EVOLUTION_URL'), apiKey: v('EVOLUTION_API_KEY'), instancia: v('EVOLUTION_INSTANCE') },
      telefono: digitos.length === 10 ? `52${digitos}` : digitos,
      funcionesUrl: v('STAGING_FUNCIONES_URL').replace(/\/+$/, ''),
      origen: v('STAGING_URL').replace(/\/+$/, ''),
      vacante: v('SMOKE_VACANTE_SLUG') || 'agente-smart',
      zonaHoraria: v('SMOKE_ZONA_HORARIA') || 'America/Mexico_City',
    },
  };
}

/** Forma pública de GET citas-api (C9 + F7.4). */
const SlotsSchema = z.object({
  vacante_id: z.string().uuid(),
  agenda_modo: z.enum(['sistema', 'whatsapp']),
  zona_horaria: z.string().min(1),
  reglas_version: z.number().int().nonnegative(),
  slots: z.array(z.object({ inicio_utc: z.string(), fin_utc: z.string(), inicio_local: z.string(), fecha: z.string(), hora_local: z.string(), disponibles: z.number() })),
});

const loggerMinimo = (salida) => {
  const l = {
    debug() {},
    info() {},
    warn: (msg, ctx) => salida(`aviso: ${msg} ${ctx ? JSON.stringify(ctx) : ''}`),
    error: (msg, ctx) => salida(`error: ${msg} ${ctx ? JSON.stringify(ctx) : ''}`),
    child: () => l,
  };
  return l;
};

/**
 * @param {{ cfg: ConfigSmoke; fetch: typeof fetch; dominio: { crearZohoCalendarAdapter: Function; construirEventoMinimo: Function; crearEvolutionAdapter: Function };
 *           ahora?: () => Date; codigo?: () => string; log?: (s: string) => void }} d
 */
export async function ejecutarSmoke(d) {
  const { cfg, dominio } = d;
  const ahora = d.ahora ?? (() => new Date());
  const log = d.log ?? (() => {});
  const checks = [];
  const anotar = (nombre, ok, detalle = '') => checks.push({ nombre, ok, detalle });
  const intentar = async (nombre, f) => {
    try {
      const r = await f();
      anotar(nombre, r.ok, r.detalle);
      return r;
    } catch (e) {
      anotar(nombre, false, e instanceof Error ? e.message : String(e));
      return { ok: false };
    }
  };

  // 1. Zoho: crear → obtener → borrar (+ confirmar que ya no existe).
  const zoho = dominio.crearZohoCalendarAdapter(cfg.zoho, { fetch: d.fetch, clock: { now: ahora }, logger: loggerMinimo(log), timeoutMs: 15_000 });
  const inicio = new Date(ahora().getTime() + 2 * 86_400_000);
  const ev = dominio.construirEventoMinimo(
    { citaId: randomUUID(), folio: 'SMOKE-NIGHTLY', nombrePila: 'Smoke', inicio: inicio.toISOString(), fin: new Date(inicio.getTime() + 30 * 60_000).toISOString() },
    { panelUrl: cfg.origen || 'https://example.invalid', zonaHoraria: cfg.zonaHoraria },
  );
  const creado = await intentar('zoho.crear', async () => {
    if (!ev.ok) return { ok: false, detalle: `evento inválido: ${ev.error}` };
    const r = await zoho.crear(cfg.calendario, ev.value);
    return r.ok ? { ok: true, detalle: 'evento creado (respuesta conforme al contrato)', uid: r.value.uid, etag: r.value.etag } : { ok: false, detalle: r.error.mensaje };
  });
  if (creado.ok) {
    await intentar('zoho.obtener', async () => {
      const r = await zoho.obtener(cfg.calendario, creado.uid);
      if (!r.ok) return { ok: false, detalle: r.error.mensaje };
      return r.value ? { ok: true, detalle: 'evento leído' } : { ok: false, detalle: 'el evento recién creado no existe' };
    });
    await intentar('zoho.borrar', async () => {
      const b = await zoho.borrar(cfg.calendario, creado.uid, creado.etag);
      if (!b.ok) return { ok: false, detalle: `NO SE BORRÓ (limpiar a mano en el calendario de prueba): ${b.error.mensaje}` };
      const r = await zoho.obtener(cfg.calendario, creado.uid);
      return r.ok && r.value === null ? { ok: true, detalle: 'evento borrado' } : { ok: false, detalle: 'el evento sigue en el calendario' };
    });
  } else {
    anotar('zoho.obtener', false, 'omitido: no se creó el evento');
    anotar('zoho.borrar', false, 'omitido: no se creó el evento');
  }

  // 2. Evolution: existe + OTP de prueba.
  const evo = (() => {
    try {
      return dominio.crearEvolutionAdapter(cfg.evolution, d.fetch);
    } catch (e) {
      return e;
    }
  })();
  const existe = await intentar('evolution.existe', async () => {
    if (evo instanceof Error) return { ok: false, detalle: evo.message };
    const si = await evo.existeEnWhatsApp(cfg.telefono);
    return { ok: si, detalle: si ? 'el número de prueba tiene WhatsApp' : 'el número de prueba NO tiene WhatsApp' };
  });
  if (existe.ok) {
    const codigo = (d.codigo ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0')))();
    await intentar('evolution.otp', async () => {
      const r = await evo.enviarTexto(cfg.telefono, `Smoke nightly Capital Humano 369: tu código de verificación de PRUEBA es ${codigo}. No requiere respuesta.`);
      return r.ok ? { ok: true, detalle: 'OTP de prueba enviado' } : { ok: false, detalle: `envío falló: ${r.error.motivo}` };
    });
  } else anotar('evolution.otp', false, 'omitido: el número de prueba no pasó existeEnWhatsApp');

  // 3. Edge functions de staging.
  await intentar('citas-api', async () => {
    const r = await d.fetch(`${cfg.funcionesUrl}/citas-api?vacante=${encodeURIComponent(cfg.vacante)}`, { headers: { origin: cfg.origen }, signal: globalThis.AbortSignal.timeout(15_000) });
    if (r.status !== 200) return { ok: false, detalle: `HTTP ${r.status}` };
    const p = SlotsSchema.safeParse(await r.json().catch(() => null));
    return p.success
      ? { ok: true, detalle: `HTTP 200, agenda_modo=${p.data.agenda_modo}, ${p.data.slots.length} slots` }
      : { ok: false, detalle: `forma inválida: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  });
  await intentar('tracking-ingest', async () => {
    const r = await d.fetch(`${cfg.funcionesUrl}/tracking-ingest`, { headers: { origin: cfg.origen }, signal: globalThis.AbortSignal.timeout(15_000) });
    // Solo acepta POST: un GET vivo responde 405; 5xx o red = caído.
    return r.status === 405 ? { ok: true, detalle: 'vivo (405 a GET, solo POST)' } : { ok: false, detalle: `HTTP ${r.status} (se esperaba 405)` };
  });

  return { ok: checks.every((c) => c.ok), checks };
}

export function resumenMarkdown(r) {
  const filas = r.checks.map((c) => `| ${c.ok ? '✅' : '❌'} | \`${c.nombre}\` | ${String(c.detalle).replace(/\|/g, '/')} |`);
  return [`### Smoke nightly (staging): ${r.ok ? 'OK' : 'FALLÓ'}`, '', '| | Verificación | Detalle |', '|---|---|---|', ...filas, ''].join('\n');
}

/** Node ejecuta los .ts del dominio con type stripping; los alias @shared/@domains se resuelven con un hook. */
async function cargarDominio() {
  register(pathToFileURL(fileURLToPath(new URL('./lib/alias-ts.mjs', import.meta.url))));
  const [zoho, comunicacion] = await Promise.all([import('../src/domains/citas/zoho/index.ts'), import('../src/domains/comunicacion/index.ts')]);
  return { crearZohoCalendarAdapter: zoho.crearZohoCalendarAdapter, construirEventoMinimo: zoho.construirEventoMinimo, crearEvolutionAdapter: comunicacion.crearEvolutionAdapter };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { faltan, cfg } = leerConfig(process.env);
  if (faltan.length) {
    console.error(`smoke-nightly: falta configuración: ${faltan.join(', ')}`);
    process.exit(2);
  }
  const r = await ejecutarSmoke({ cfg, fetch: globalThis.fetch, dominio: await cargarDominio(), log: (s) => console.error(s) });
  for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.nombre}: ${c.detalle}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, resumenMarkdown(r));
  process.exit(r.ok ? 0 : 1);
}
