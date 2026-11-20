#!/usr/bin/env node
/**
 * C11 con concurrencia REAL en Postgres (Supabase local o staging), sin driver de Node: N procesos `psql`
 * en paralelo, cada uno con su propia conexión (backend), sincronizados con una barrera de reloj
 * (pg_sleep hasta un instante común) para que compitan de verdad por el advisory lock.
 *
 *   SUPABASE_DB_URL_LOCAL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/c11-concurrencia.mjs
 *
 * Escenarios:
 *   A. 9 retenciones previas en el día (cupo 10) + 20 retenciones simultáneas al ÚLTIMO lugar → exactamente 1 OK.
 *   B. 50 retenciones simultáneas a 50 slots distintos (capacidad 1, cupo 10) → exactamente 10 OK; nunca > 10 activas.
 *   C. 2 corridas simultáneas de privacidad.retencion_diaria (cada una sostiene su transacción) → una `omitida`.
 * Imprime un JSON con los resultados; sale con código 1 si algo no se cumple. Limpia sus datos (salvo el
 * registro de supresiones de C, que es parte del contrato PRV-03).
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const URL = process.env.SUPABASE_DB_URL_LOCAL;
if (!URL) {
  console.error('Falta SUPABASE_DB_URL_LOCAL');
  process.exit(2);
}

const psqlSync = (sql) =>
  execFileSync('psql', [URL, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();

/** Ejecuta `sql` en un proceso psql propio; resuelve con la salida (tuplas sin formato). */
function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const p = spawn('psql', [URL, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `psql salió con ${code}`))));
    p.stdin.end(sql);
  });
}

/** Barrera: cada proceso duerme hasta `t` (epoch ms) antes de ejecutar. */
const barrera = (t) => `select pg_sleep(greatest(0, ${t / 1000} - extract(epoch from clock_timestamp())));\n`;

const ZONA = 'America/Mexico_City';
const retenerSql = ({ vacante, lead, inicio, capacidad = 1, cupo = 10 }) =>
  `select citas.retener('${vacante}'::uuid, '${lead}'::uuid, '${inicio}'::timestamptz, '${inicio}'::timestamptz + interval '90 min',
     ('${inicio}'::timestamptz at time zone '${ZONA}')::date, ${capacidad}, ${cupo}, true, 0, now() + interval '10 min', now()) ->> 'resultado';`;

function crearVacante() {
  const cliente = randomUUID();
  const vacante = randomUUID();
  const slug = `c11-${vacante.slice(0, 8)}`;
  psqlSync(`insert into shared.clientes (id, nombre) values ('${cliente}', 'C11');
            insert into shared.vacantes (id, cliente_id, slug, codigo, nombre) values ('${vacante}', '${cliente}', '${slug}', '${slug.toUpperCase()}', 'C11');`);
  return { cliente, vacante };
}

function limpiar({ cliente, vacante }) {
  psqlSync(`delete from citas.citas where vacante_id = '${vacante}';
            delete from shared.outbox where cliente_id = '${cliente}';
            delete from shared.vacantes where id = '${vacante}';
            delete from shared.clientes where id = '${cliente}';`);
}

const conteo = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
// Mañana 10:00 local de CDMX (UTC-6) en UTC, y slots cada 30 min desde ahí.
const base = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1, 16, 0, 0));
const slot = (i) => new Date(base.getTime() + i * 30 * 60_000).toISOString();

async function escenarioA() {
  const v = crearVacante();
  try {
    for (let i = 0; i < 9; i++) psqlSync(retenerSql({ ...v, lead: randomUUID(), inicio: slot(i) }));
    const t = Date.now() + 1500;
    const r = await Promise.all(Array.from({ length: 20 }, () => psqlAsync(barrera(t) + retenerSql({ ...v, lead: randomUUID(), inicio: slot(9) }))));
    const resultados = conteo(r.map((x) => x.split('\n').at(-1)));
    const activas = Number(psqlSync(`select count(*) from citas.citas where vacante_id = '${v.vacante}' and estado in ('retenida', 'confirmada')`));
    return { peticiones: 20, resultados, activas, ok: resultados.OK === 1 && activas === 10 };
  } finally {
    limpiar(v);
  }
}

async function escenarioB() {
  const v = crearVacante();
  try {
    const t = Date.now() + 2000;
    // 50 slots DISTINTOS cada 10 min desde las 10:00 local (todos en el mismo día local): solo el cupo diario limita.
    const distinto = (i) => new Date(base.getTime() + i * 10 * 60_000).toISOString();
    const r = await Promise.all(Array.from({ length: 50 }, (_, i) => psqlAsync(barrera(t) + retenerSql({ ...v, lead: randomUUID(), inicio: distinto(i) }))));
    const resultados = conteo(r.map((x) => x.split('\n').at(-1)));
    const porDia = psqlSync(`select string_agg(n::text, ',') from (select count(*) n from citas.citas where vacante_id = '${v.vacante}' and estado in ('retenida','confirmada') group by dia_local) x`);
    const maxDia = Math.max(...porDia.split(',').map(Number));
    return { peticiones: 50, resultados, activas_por_dia: porDia, ok: resultados.OK === 10 && maxDia === 10 };
  } finally {
    limpiar(v);
  }
}

async function escenarioC() {
  const t = Date.now() + 1500;
  const corrida = `${barrera(t)}begin;\nselect coalesce((privacidad.retencion_diaria(now()) ->> 'omitida'), 'false');\nselect pg_sleep(2);\ncommit;\n`;
  const r = await Promise.all([psqlAsync(corrida), psqlAsync(corrida)]);
  const omitidas = r.map((x) => x.split('\n').filter((l) => l === 'true' || l === 'false')[0]);
  return { corridas: 2, omitidas: conteo(omitidas), ok: omitidas.filter((x) => x === 'true').length === 1 };
}

const salida = { postgres: psqlSync('show server_version'), A_ultimo_lugar: await escenarioA(), B_cupo_diario: await escenarioB(), C_retencion_diaria: await escenarioC() };
salida.ok = salida.A_ultimo_lugar.ok && salida.B_cupo_diario.ok && salida.C_retencion_diaria.ok;
console.log(JSON.stringify(salida, null, 2));
process.exit(salida.ok ? 0 : 1);
