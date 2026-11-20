/** NFR-CI-01: el pipeline real cumple las compuertas; los anti-patrones se detectan. */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parsearWorkflow, specsNoCubiertos, validarDirectorio, validarNightly, validarPipelineDeploy, validarWorkflow } from './validar-workflows.mjs';

const RAIZ = join(import.meta.dirname, '..');

// El deploy.yml original (rsync de la raíz sin build ni pruebas).
const DEPLOY_ORIGINAL = `
name: Deploy al servidor por SSH
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: produccion
    steps:
      - uses: actions/checkout@v4
      - name: Sincronizar archivos
        env:
          SSH_HOST: \${{ secrets.SSH_HOST }}
        run: |
          rsync -avz --delete \\
            ./ "$SSH_USER@$SSH_HOST:$DEPLOY_PATH/"
`;

describe('workflows del repositorio', () => {
  it('.github/workflows es válido (deploy.yml, nightly.yml y no-funcionales.yml) y cubre todos los e2e/*.spec.ts', () => {
    expect(validarDirectorio(join(RAIZ, '.github', 'workflows'))).toEqual([]);
  });
});

describe('detecta anti-patrones', () => {
  it('el deploy original sin compuertas es rechazado', () => {
    const wf = parsearWorkflow(DEPLOY_ORIGINAL);
    const errores = [...validarWorkflow('deploy.yml', wf), ...validarPipelineDeploy('deploy.yml', wf)].join('\n');
    expect(errores).toMatch(/falta el job calidad/);
    expect(errores).toMatch(/deploy no depende de build/);
    expect(errores).toMatch(/limitarse a main/);
    expect(errores).toMatch(/raíz del repo/);
    expect(errores).toMatch(/persist-credentials/);
    expect(errores).toMatch(/timeout-minutes/);
  });

  it('needs inexistente, acción sin versión, secretos sin environment, permisos de escritura, inyección', () => {
    const wf = parsearWorkflow(`
on: push
permissions: write-all
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [fantasma]
    steps:
      - uses: actions/setup-node@main
      - run: echo "\${{ secrets.TOKEN }}"
      - run: echo "\${{ github.event.pull_request.title }}"
`);
    const errores = validarWorkflow('x.yml', wf).join('\n');
    expect(errores).toMatch(/needs inexistente "fantasma"/);
    expect(errores).toMatch(/sin versión fija \(actions\/setup-node@main\)/);
    expect(errores).toMatch(/usa secretos \(TOKEN\) sin `environment`/);
    expect(errores).toMatch(/no debe otorgar escritura/);
    expect(errores).toMatch(/no confiables/);
  });

  it('YAML inválido o con llaves duplicadas lanza error', () => {
    expect(() => parsearWorkflow('jobs:\n  a: [1, 2\n')).toThrow();
    expect(() => parsearWorkflow('on: push\non: pull_request\n')).toThrow();
  });
});

const job = (run: string, extra = '') => `
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 5
${extra}    steps:
      - run: ${run}`;
const wfCon = (jobs: string) => parsearWorkflow(`on: push\npermissions:\n  contents: read\njobs:${jobs}`);
const SPECS = ['candidato.spec.ts', 'smoke.spec.ts', 'rendimiento.spec.ts'];

describe('NFR-CI-01 · cobertura de la batería E2E', () => {
  it('`playwright test` sin archivos ni proyectos cubre todo', () => {
    expect(specsNoCubiertos(wfCon(job('npx playwright test')), SPECS)).toEqual([]);
  });
  it('solo smoke + headers deja fuera los demás specs', () => {
    expect(specsNoCubiertos(wfCon(job('npx playwright test e2e/smoke.spec.ts e2e/headers.spec.ts')), SPECS)).toEqual(['candidato.spec.ts', 'rendimiento.spec.ts']);
  });
  it('archivos listados en varios jobs suman cobertura; un --project limitado no cuenta como batería completa', () => {
    const wf = wfCon(job('npx playwright test e2e/candidato.spec.ts e2e/rendimiento.spec.ts') + job('npx playwright test smoke', '').replace('  e2e:', '  e2e2:'));
    expect(specsNoCubiertos(wf, SPECS)).toEqual([]);
    expect(specsNoCubiertos(wfCon(job('npx playwright test --project=desktop')), SPECS)).toEqual(['proyectos: iphone-13, pixel-7, rendimiento-desktop, rendimiento-movil']);
  });
  it('el validador de deploy exige el job e2e como compuerta y la batería completa sobre el build de PRUEBA', () => {
    const wf = parsearWorkflow(`
on: push
permissions:
  contents: read
jobs:
  calidad: { runs-on: x, timeout-minutes: 1, steps: [{ run: 'npm run typecheck && npm run lint && npm run test:unit && npm run test:integration && npm run test:db && coverage' }] }
  pgtap: { runs-on: x, timeout-minutes: 1, steps: [{ run: 'supabase test db' }] }
  build: { runs-on: x, timeout-minutes: 1, steps: [{ run: 'npm run build' }, { run: 'npm run scan:secrets' }, { run: 'npx playwright test e2e/smoke.spec.ts' }] }
  deploy: { runs-on: x, timeout-minutes: 1, needs: [calidad, pgtap, build], if: "github.ref == 'refs/heads/main'", environment: produccion, steps: [{ run: 'rsync --delete ./sitio/ x' }] }
`);
    const errores = validarPipelineDeploy('deploy.yml', wf).join('\n');
    expect(errores).toMatch(/falta el job e2e/);
    expect(errores).toMatch(/deploy no depende de e2e/);
    expect(errores).toMatch(/build de producción debe usar vars\.NEXT_PUBLIC_SUPABASE_URL/);
    expect(errores).toMatch(/csp-hashes/);
    expect(errores).toMatch(/c11-concurrencia/);
  });
});

describe('§3.1 · smoke nightly', () => {
  it('exige cron + manual, environment staging, script smoke-nightly y aviso si faltan secretos', () => {
    const mal = parsearWorkflow(`
on: push
permissions:
  contents: read
jobs:
  smoke: { runs-on: x, timeout-minutes: 1, steps: [{ run: 'echo hola' }] }
`);
    const e = validarNightly('nightly.yml', mal).join('\n');
    expect(e).toMatch(/schedule/);
    expect(e).toMatch(/workflow_dispatch/);
    expect(e).toMatch(/environment: staging/);
    expect(e).toMatch(/smoke-nightly/);
    expect(e).toMatch(/omitido/);
  });
});
