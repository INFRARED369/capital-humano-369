/**
 * E2E (Playwright) sobre el export estático `apps/web/out` servido por scripts/serve-out.mjs
 * (mismos headers que infra/nginx). Con STAGING_URL apunta a staging y no levanta servidor.
 * Proyectos: desktop, iPhone 13 (WebKit) y Pixel 7 (Chromium) — E2E-13. El gate de LCP (NFR-RND-01) va en
 * rendimiento-movil/rendimiento-desktop, que dependen de desktop y pixel-7 (corren al final, sin contención).
 *   npm run build && npx playwright test e2e/smoke.spec.ts --project=desktop
 */
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const STAGING_URL = process.env.STAGING_URL?.replace(/\/$/, '');
const PORT = Number(process.env.E2E_PORT ?? 4173);
const baseURL = STAGING_URL ?? `http://127.0.0.1:${PORT}`;
const RENDIMIENTO = /rendimiento\.spec\.ts$/;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL,
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: RENDIMIENTO },
    { name: 'iphone-13', use: { ...devices['iPhone 13'] }, testIgnore: RENDIMIENTO },
    { name: 'pixel-7', use: { ...devices['Pixel 7'] }, testIgnore: RENDIMIENTO },
    // NFR-RND-01: el gate de LCP corre DESPUÉS de los funcionales (sin competir por CPU), 1 worker, en Chromium.
    { name: 'rendimiento-movil', use: { ...devices['Pixel 7'] }, testMatch: RENDIMIENTO, dependencies: ['desktop', 'pixel-7'], fullyParallel: false },
    { name: 'rendimiento-desktop', use: { ...devices['Desktop Chrome'] }, testMatch: RENDIMIENTO, dependencies: ['rendimiento-movil'], fullyParallel: false },
  ],
  webServer: STAGING_URL
    ? undefined
    : {
        command: `node scripts/serve-out.mjs --port ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !CI,
        timeout: 30_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
