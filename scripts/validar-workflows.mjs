#!/usr/bin/env node
/**
 * Valida los workflows de GitHub Actions (NFR-CI-01): YAML parseable, `needs` existentes,
 * permisos mínimos, acciones con versión fija, secretos solo en jobs con `environment`
 * y, para deploy.yml, que el deploy dependa de TODAS las compuertas y solo corra en main, que la batería
 * Playwright COMPLETA (todo e2e/*.spec.ts, todos los proyectos) corra sobre un build de PRUEBA, que el
 * artefacto desplegado se construya con las variables reales (vars.NEXT_PUBLIC_*), CSP por hashes y C11 real.
 * Para nightly.yml: cron + manual, environment staging, scripts/smoke-nightly.mjs y aviso si se omite.
 * Uso: node scripts/validar-workflows.mjs [.github/workflows]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parser YAML: paquete `yaml` si existe; si no, el que trae playwright-core (dependencia ya instalada). */
function cargarYaml() {
  const require = createRequire(import.meta.url);
  try {
    return require('yaml');
  } catch {
    return require('playwright-core/lib/utilsBundle').yaml;
  }
}
const YAML = cargarYaml();

export function parsearWorkflow(texto) {
  const doc = YAML.parseDocument(texto, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('; '));
  return doc.toJS();
}

const lista = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const COMPUERTAS_DEPLOY = ['calidad', 'pgtap', 'build', 'e2e'];
/** Proyectos de playwright.config.ts que el CI debe correr (WebKit incluido: iphone-13). */
export const PROYECTOS_E2E = ['desktop', 'iphone-13', 'pixel-7', 'rendimiento-movil', 'rendimiento-desktop'];
const OPCIONES_CON_VALOR = new Set(['-g', '--grep', '--grep-invert', '--project', '--reporter', '--workers', '-j', '-c', '--config', '--retries', '--shard', '--timeout', '--output']);

const runs = (job) => lista(job?.steps).map((s) => s.run ?? '').join('\n');

/** Invocaciones de `playwright test` de todo el workflow: filtros de archivo y proyectos (vacío = todos). */
function invocacionesPlaywright(wf) {
  const out = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const m of runs(job).replace(/\\\n/g, ' ').matchAll(/playwright test([^\n&|;]*)/g)) {
      const tokens = m[1].trim().split(/\s+/).filter(Boolean);
      const filtros = [];
      const proyectos = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const [flag, valor] = t.split('=', 2);
        if (flag === '--project') proyectos.push(valor ?? tokens[++i]);
        else if (t.startsWith('-')) { if (OPCIONES_CON_VALOR.has(t)) i++; }
        else filtros.push(t);
      }
      out.push({ filtros, proyectos });
    }
  }
  return out;
}

/**
 * Specs de e2e/ que ningún `playwright test` del workflow corre (los filtros posicionales de Playwright son
 * regex sobre la ruta del archivo) y, si faltan proyectos, una entrada "proyectos: …".
 */
export function specsNoCubiertos(wf, specs, proyectos = PROYECTOS_E2E) {
  const inv = invocacionesPlaywright(wf);
  const cubre = (f, spec) => {
    try {
      return new RegExp(f).test(`e2e/${spec}`);
    } catch {
      return `e2e/${spec}`.includes(f);
    }
  };
  const faltan = specs.filter((spec) => !inv.some((x) => x.filtros.length === 0 || x.filtros.some((f) => cubre(f, spec))));
  const corridos = new Set(inv.flatMap((x) => (x.proyectos.length ? x.proyectos : proyectos)));
  const sinProyecto = proyectos.filter((p) => !corridos.has(p)).sort();
  return sinProyecto.length ? [...faltan, `proyectos: ${sinProyecto.join(', ')}`] : faltan;
}

/** Devuelve la lista de errores de un workflow ya parseado. */
export function validarWorkflow(nombre, wf) {
  const errores = [];
  const e = (m) => errores.push(`${nombre}: ${m}`);
  if (!wf || typeof wf !== 'object') return [`${nombre}: documento vacío`];
  if (!wf.on) e('falta `on`');
  if (!wf.jobs || typeof wf.jobs !== 'object') return [...errores, `${nombre}: falta \`jobs\``];

  const perms = wf.permissions;
  if (!perms) e('falta `permissions` de nivel superior (GITHUB_TOKEN con permisos mínimos)');
  else if (perms === 'write-all' || Object.values(perms).includes('write')) e('`permissions` de nivel superior no debe otorgar escritura');

  for (const [id, job] of Object.entries(wf.jobs)) {
    for (const n of lista(job.needs)) if (!wf.jobs[n]) e(`job ${id}: needs inexistente "${n}"`);
    if (job.permissions === 'write-all') e(`job ${id}: permissions write-all`);
    if (!job['timeout-minutes']) e(`job ${id}: sin timeout-minutes`);
    const texto = JSON.stringify(job);
    const secretos = [...texto.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).filter((s) => s !== 'GITHUB_TOKEN');
    if (secretos.length && !job.environment) e(`job ${id}: usa secretos (${[...new Set(secretos)].join(', ')}) sin \`environment\``);
    for (const paso of lista(job.steps)) {
      if (paso.uses && !/@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/.test(paso.uses)) e(`job ${id}: acción sin versión fija (${paso.uses})`);
      if (paso.uses?.startsWith('actions/checkout') && paso.with?.['persist-credentials'] !== false)
        e(`job ${id}: checkout debe usar persist-credentials: false`);
      if (paso.run && /\$\{\{\s*github\.event\.(pull_request|issue|comment|head_commit)\./.test(paso.run))
        e(`job ${id}: interpolación de datos no confiables en run (usar env)`);
    }
  }
  return errores;
}

/** Reglas específicas del pipeline de deploy (NFR-CI-01). */
export function validarPipelineDeploy(nombre, wf) {
  const errores = [];
  const e = (m) => errores.push(`${nombre}: ${m}`);
  const jobs = wf.jobs ?? {};
  for (const j of [...COMPUERTAS_DEPLOY, 'deploy']) if (!jobs[j]) e(`falta el job ${j}`);
  const deploy = jobs.deploy;
  if (!deploy) return errores;
  const needs = lista(deploy.needs);
  for (const c of COMPUERTAS_DEPLOY) if (!needs.includes(c)) e(`deploy no depende de ${c}`);
  if (!/refs\/heads\/main/.test(deploy.if ?? '')) e('deploy debe limitarse a main');
  if (/pull_request/.test(deploy.if ?? '') && !/!=\s*'pull_request'/.test(deploy.if)) e('deploy no debe correr en pull_request');
  if (deploy.environment !== 'produccion' && deploy.environment?.name !== 'produccion') e('deploy debe usar environment: produccion');
  const runDeploy = lista(deploy.steps).map((s) => s.run ?? '').join('\n');
  if (!/rsync[^\n]*--delete/.test(runDeploy)) e('deploy debe usar rsync --delete');
  if (/rsync[\s\S]*\s\.\/\s/.test(runDeploy)) e('deploy no debe sincronizar la raíz del repo');
  const pasosBuild = lista(jobs.build?.steps).map((s) => s.run ?? '').join('\n');
  for (const [re, m] of [
    [/npm run build/, 'build debe correr npm run build'],
    [/scan:secrets|scan-secrets/, 'build debe escanear secretos'],
    [/playwright test/, 'build debe correr el E2E smoke'],
  ]) if (!re.test(pasosBuild)) e(m);
  const iBuild = pasosBuild.indexOf('npm run build');
  const iScan = pasosBuild.search(/scan:secrets|scan-secrets/);
  if (iBuild >= 0 && iScan >= 0 && iScan < iBuild) e('el escaneo de secretos debe ir después del build');
  const pasosCalidad = lista(jobs.calidad?.steps).map((s) => s.run ?? '').join('\n');
  for (const s of ['typecheck', 'lint', 'test:unit', 'test:integration', 'test:db', 'coverage'])
    if (!pasosCalidad.includes(s)) e(`calidad no corre ${s}`);

  // Dos builds: PRODUCCIÓN (build → artefacto `sitio`) con vars reales y PRUEBA (e2e) con valores de prueba.
  const envDe = (j) => ({ ...(wf.env ?? {}), ...(jobs[j]?.env ?? {}) });
  if (!/vars\.NEXT_PUBLIC_SUPABASE_URL/.test(String(envDe('build').NEXT_PUBLIC_SUPABASE_URL ?? '')))
    e('el build de producción debe usar vars.NEXT_PUBLIC_SUPABASE_URL (es el artefacto que se despliega)');
  if (jobs.e2e) {
    if (envDe('e2e').NEXT_PUBLIC_SUPABASE_URL !== 'https://e2e.supabase.co')
      e('e2e debe construir con las variables de PRUEBA (NEXT_PUBLIC_SUPABASE_URL=https://e2e.supabase.co)');
    const pasosE2e = runs(jobs.e2e);
    if (!/npm run build/.test(pasosE2e)) e('e2e debe hacer su propio build de prueba');
    if (!/playwright install[^\n]*webkit/.test(pasosE2e)) e('e2e debe instalar WebKit (iphone-13)');
    const reporte = lista(jobs.e2e.steps).some((st) => st.uses?.startsWith('actions/upload-artifact') && /failure\(\)/.test(st.if ?? '') && /playwright-report/.test(JSON.stringify(st.with ?? {})));
    if (!reporte) e('e2e debe subir playwright-report como artefacto si falla');
  }
  for (const j of ['build', 'e2e']) {
    const t = runs(jobs[j]);
    const iB = t.indexOf('npm run build');
    const iC = t.search(/csp-hashes|csp:hashes/);
    if (jobs[j] && (iC < 0 || iC < iB)) e(`${j} debe generar la CSP con hashes (scripts/csp-hashes.mjs) después del build`);
  }
  const pasosPgtap = runs(jobs.pgtap);
  if (!/SUPABASE_DB_URL_LOCAL=\S+[^\n]*c11-concurrencia/.test(pasosPgtap))
    e('pgtap debe correr C11 real (scripts/c11-concurrencia.test.ts) contra el Postgres local');
  return errores;
}

/** §3.1: smoke nightly contra staging. */
export function validarNightly(nombre, wf) {
  const errores = [];
  const e = (m) => errores.push(`${nombre}: ${m}`);
  const on = typeof wf.on === 'string' ? { [wf.on]: null } : Array.isArray(wf.on) ? Object.fromEntries(wf.on.map((k) => [k, null])) : (wf.on ?? {});
  if (!lista(on.schedule).some((x) => typeof x?.cron === 'string')) e('falta `on.schedule` con cron');
  if (!('workflow_dispatch' in on)) e('falta `on.workflow_dispatch` (ejecución manual)');
  const jobs = Object.values(wf.jobs ?? {});
  if (!jobs.some((j) => j.environment === 'staging' || j.environment?.name === 'staging')) e('el smoke debe usar environment: staging');
  if (!jobs.some((j) => /smoke-nightly\.mjs/.test(runs(j)))) e('debe correr scripts/smoke-nightly.mjs');
  const avisa = jobs.some((j) => lista(j.steps).some((st) => /::warning[ :]/.test(st.run ?? '') && /omitido/i.test(st.run ?? '')));
  const condicionado = jobs.some((j) => lista(j.steps).some((st) => /smoke-nightly/.test(st.run ?? '') && /secretos|habilitado/.test(String(st.if ?? j.if ?? ''))));
  if (!avisa || !condicionado) e('si faltan secretos el smoke debe quedar omitido con `if:` y un paso que lo avise (::warning:: … omitido)');
  return errores;
}

export function validarDirectorio(dir, dirE2e = join(dir, '..', '..', 'e2e')) {
  const specs = existsSync(dirE2e) ? readdirSync(dirE2e).filter((f) => f.endsWith('.spec.ts')).sort() : [];
  const errores = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    let wf;
    try {
      wf = parsearWorkflow(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      errores.push(`${f}: YAML inválido: ${err.message}`);
      continue;
    }
    errores.push(...validarWorkflow(f, wf));
    if (f === 'deploy.yml') {
      errores.push(...validarPipelineDeploy(f, wf));
      for (const x of specsNoCubiertos(wf, specs))
        errores.push(`${f}: ${x.startsWith('proyectos:') ? `faltan ${x}` : `e2e/${x} no lo corre ningún \`playwright test\``} (NFR-CI-01)`);
    }
    if (f === 'nightly.yml') errores.push(...validarNightly(f, wf));
  }
  return errores;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? '.github/workflows';
  const errores = validarDirectorio(dir);
  if (errores.length) {
    for (const x of errores) console.error(`✗ ${x}`);
    process.exit(1);
  }
  console.log(`validar-workflows: ${readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).join(', ')} OK`);
}
