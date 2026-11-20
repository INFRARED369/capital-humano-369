/**
 * `test` extendido para todos los E2E:
 *
 *   import { test, expect } from './fixtures';
 *   test('E2E-01', async ({ page, backend, terceros, proveedores }) => { ... });
 *
 *  - terceros   (auto): GTM/GA4/Pixel/Clarity/Turnstile stubeados + errores de JS y de CSP (el test FALLA
 *                       si hubo un `securitypolicyviolation`: script-src sin 'unsafe-inline', hashes por build).
 *  - backend    (auto): Supabase simulado con estado (edge functions, Auth, PostgREST con RLS) conectado al
 *                       contexto del navegador del test; sus workers llaman a `proveedores`.
 *  - funciones:         alias de `backend` (registro de llamadas y `responder` para forzar fallas).
 *  - proveedores:       servidor HTTP de mocks de Zoho/CAPI/Stape/Evolution/NBX (uno por worker, se reinicia por test).
 *  - otroNavegador:     abre otra página en un contexto NUEVO (otro candidato) conectado al MISMO backend (E2E-04/05).
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { crearBackend, type BackendSimulado } from './backend';
import { stubTerceros, type RegistroTerceros } from './navegador';
import { iniciarMocksProveedores, type MocksProveedores } from './proveedores';

export const test = base.extend<
  { terceros: RegistroTerceros; backend: BackendSimulado; funciones: BackendSimulado; otroNavegador: () => Promise<{ page: Page; terceros: RegistroTerceros }> },
  { proveedores: MocksProveedores }
>({
  terceros: [
    async ({ page }, use) => {
      const reg = await stubTerceros(page);
      await use(reg);
      // CSP con hashes por build: cualquier violación (script inline sin hash, origen no permitido) rompe el test.
      expect(reg.violacionesCsp, 'violaciones de CSP (securitypolicyviolation)').toEqual([]);
    },
    { auto: true },
  ],
  backend: [
    async ({ context, proveedores }, use) => {
      proveedores.reiniciar();
      const b = crearBackend(proveedores);
      await b.conectar(context);
      await use(b);
      await b.procesarColas();
    },
    { auto: true },
  ],
  funciones: async ({ backend }, use) => use(backend),
  otroNavegador: async ({ browser, backend }, use, info) => {
    const abiertos: BrowserContext[] = [];
    const registros: RegistroTerceros[] = [];
    const u = info.project.use;
    await use(async () => {
      const c = await browser.newContext({
        baseURL: u.baseURL, viewport: u.viewport, userAgent: u.userAgent, deviceScaleFactor: u.deviceScaleFactor,
        isMobile: u.isMobile, hasTouch: u.hasTouch, locale: u.locale, timezoneId: u.timezoneId,
      });
      abiertos.push(c);
      await backend.conectar(c);
      const page = await c.newPage();
      const terceros = await stubTerceros(page);
      registros.push(terceros);
      return { page, terceros };
    });
    await Promise.all(abiertos.map((c) => c.close()));
    expect(registros.flatMap((r) => r.violacionesCsp), 'violaciones de CSP en otro navegador').toEqual([]);
  },
  proveedores: [
    // eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar fixtures
    async ({}, use) => {
      const m = await iniciarMocksProveedores();
      await use(m);
      await m.cerrar();
    },
    { scope: 'worker' },
  ],
});

export { expect };
export * from './entorno';
export * from './backend';
export * from './flujo';
export { stubTerceros } from './navegador';
export { RESPUESTAS_DEFECTO } from './proveedores';
