/**
 * Smoke E2E sobre out/ (NFR-CI-01): rutas críticas 200, 404 real, trailingSlash y axe
 * sin violaciones serias/críticas (NFR-A11Y-01, E2E-13) en desktop, iPhone 13 y Pixel 7.
 * Aserciones robustas: válidas para el esqueleto actual y para las páginas portadas.
 */
import { axeGraves, expect, test } from './fixtures';
import { ESTRICTO, RUTAS_CRITICAS, rutaExportada } from './fixtures/entorno';

for (const ruta of RUTAS_CRITICAS) {
  test.describe(`ruta crítica ${ruta}`, () => {
    test.beforeEach(() => {
      if (!ESTRICTO && !rutaExportada(ruta)) test.skip(true, `${ruta} aún no está en out/ (pendiente del port; en CI esto FALLA)`);
    });

    test('responde 200 con HTML en español, título y encabezado visible', async ({ page, terceros }) => {
      const res = await page.goto(ruta);
      expect(res?.status(), `${ruta} debe responder 200`).toBe(200);
      expect(res?.headers()['content-type']).toMatch(/text\/html/);
      await expect(page.locator('html')).toHaveAttribute('lang', /^es/);
      await expect(page).toHaveTitle(/\S/);
      await expect(page.locator('h1').first()).toBeVisible();
      expect(terceros.erroresPagina, 'errores de JS en la página').toEqual([]);
      expect(terceros.violacionesCsp, 'violaciones de CSP').toEqual([]);
    });

    test('axe: sin violaciones serias ni críticas (WCAG 2.1 AA)', async ({ page }) => {
      await page.goto(ruta);
      expect(await axeGraves(page)).toEqual([]);
    });
  });
}

test('sin barra final redirige 301 conservando la query (URLs de campañas)', async ({ request }) => {
  test.skip(!ESTRICTO && !rutaExportada('/vacantes/agente-smart/'), 'agente-smart aún no está en out/');
  const r = await request.get('/vacantes/agente-smart?utm_source=meta&utm_campaign=x', { maxRedirects: 0 });
  expect(r.status()).toBe(301);
  expect(r.headers()['location']).toMatch(/\/vacantes\/agente-smart\/\?utm_source=meta&utm_campaign=x$/);
});

test('una ruta inexistente responde 404 con página propia', async ({ page }) => {
  const res = await page.goto('/ruta-que-no-existe-e2e/');
  expect(res?.status()).toBe(404);
  await expect(page.locator('body')).not.toBeEmpty();
});
