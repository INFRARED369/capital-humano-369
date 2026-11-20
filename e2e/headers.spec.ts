/**
 * E2E-14 · Headers de seguridad en la respuesta REAL (NFR-SEG-07).
 * Local: contra serve-out (mismos headers que infra/nginx). Staging: STAGING_URL=https://… npx playwright test
 * e2e/headers.spec.ts --project=desktop (exige además HSTS). Cubre HTML, panel, cita, assets estáticos y 404.
 * Independiente del navegador: corre solo en el proyecto desktop.
 */
import { expect, test } from './fixtures';
import { verificarHeaders } from '../infra/nginx/headers-esperados';
import { rutaExportada } from './fixtures/entorno';

// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar fixtures
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'los headers no dependen del navegador');
});

const exigirHsts = (baseURL: string | undefined) => !!baseURL?.startsWith('https://');

const RUTAS = ['/', '/vacantes/agente-smart/', '/aviso-de-privacidad/', '/panel/', '/panel/acceso/', '/panel/citas/', '/cita/', '/cita/gestionar/', '/vacantes/agente-smart/Agente_Smart_VF.mp4', '/logo-369.png', '/ruta-que-no-existe-e2e/'];

for (const ruta of RUTAS) {
  test(`headers de seguridad en ${ruta}`, async ({ request, baseURL }) => {
    test.skip(ruta !== '/' && !ruta.startsWith('/ruta-que') && !rutaExportada(ruta), 'ruta aún no exportada');
    const r = await request.get(ruta, { maxRedirects: 0 });
    expect(verificarHeaders(r.headers(), { exigirHsts: exigirHsts(baseURL) })).toEqual([]);
  });
}

test('HTML se revalida y _next/static es inmutable', async ({ request }) => {
  const r = await request.get('/');
  expect(r.headers()['cache-control']).toMatch(/no-cache/);
  const asset = /(?:src|href)="(\/_next\/static\/[^"]+\.(?:js|css))"/.exec(await r.text())?.[1];
  expect(asset, 'la portada referencia assets de _next/static').toBeTruthy();
  const a = await request.get(asset!);
  expect(a.status()).toBe(200);
  expect(a.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(verificarHeaders(a.headers(), { exigirHsts: false })).toEqual([]);
});

test('métodos distintos de GET/HEAD se rechazan en el sitio estático', async ({ request }) => {
  const r = await request.post('/', { data: {} });
  expect([403, 405]).toContain(r.status());
});
