/**
 * E2E-13 · Accesibilidad (NFR-A11Y-01: axe WCAG 2.1 AA sin violaciones serias/críticas) y uso móvil en TODAS las
 * páginas y pasos: portada, vacante (formulario, errores, horario, OTP, pase, respaldo), aviso, panel (acceso,
 * vacantes, reglas, agenda, cita, dashboard, alta, establecer contraseña) y cita (cancelar/reprogramar).
 * Corre en desktop, iphone-13 y pixel-7. En móvil además: sin scroll horizontal y controles táctiles ≥ 24 px.
 */
import type { Page } from '@playwright/test';
import {
  IDS, LANDING, USUARIOS, axeGraves, botonEnviarCodigo, decidirCookies, elegirHorario, entrarAlPanel, escribirOtp, esperarOtp, expect, jwtDe, llenarDatos, test,
} from './fixtures';

/** Sin scroll horizontal y controles interactivos visibles con al menos 24×24 px (WCAG 2.2 2.5.8, mínimo). */
async function usableEnMovil(page: Page, raiz = 'body'): Promise<void> {
  const ancho = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vp: window.innerWidth }));
  expect(ancho.doc, 'sin scroll horizontal').toBeLessThanOrEqual(ancho.vp + 1);
  const chicos = await page.locator(raiz).evaluate((r) =>
    [...r.querySelectorAll<HTMLElement>('button, input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ id: e.id || e.textContent?.trim().slice(0, 30) || e.tagName, ...e.getBoundingClientRect().toJSON() }))
      .filter((b) => b.width < 24 || b.height < 24)
      .map((b) => `${b.id} ${Math.round(b.width)}×${Math.round(b.height)}`),
  );
  expect(chicos, 'controles de menos de 24 px').toEqual([]);
}

const esMovil = (p: Page) => (p.viewportSize()?.width ?? 1280) < 600;

test('portada y aviso de privacidad', async ({ page }) => {
  for (const [i, ruta] of ['/', '/aviso-de-privacidad/'].entries()) {
    await page.goto(ruta);
    if (i === 0) await decidirCookies(page, 'Rechazar');
    expect(await axeGraves(page), ruta).toEqual([]);
    if (esMovil(page)) {
      const ancho = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(ancho, `${ruta} sin scroll horizontal`).toBeLessThanOrEqual(1);
    }
  }
});

test('banner de consentimiento', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Tu privacidad' })).toBeVisible();
  expect(await axeGraves(page)).toEqual([]);
  if (esMovil(page)) await usableEnMovil(page, '[role=dialog]');
});

test('vacante: cada paso del formulario (datos, errores, horario, OTP, pase) es accesible y usable en móvil', async ({ page, proveedores }) => {
  test.slow(); // recorrido completo con varios análisis axe: holgura ante CPU compartida en CI
  await page.goto(LANDING);
  await decidirCookies(page, 'Rechazar');
  // Al cargar, el formulario no roba el foco (ni dispara FormStarted / carga del validador sin interacción).
  expect(await page.evaluate(() => !!document.activeElement?.closest('#postularme'))).toBe(false);
  await page.locator('#postularme').scrollIntoViewIfNeeded();
  expect(await axeGraves(page), 'datos').toEqual([]);
  if (esMovil(page)) await usableEnMovil(page, '#postularme');

  // Errores: enviar vacío → campos marcados, mensajes asociados y foco en el primero.
  await page.getByRole('button', { name: /Continuar: elegir día y hora/ }).click();
  await expect(page.locator('#campo-nombre')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#campo-nombre')).toBeFocused();
  const desc = await page.locator('#campo-nombre').getAttribute('aria-describedby');
  await expect(page.locator(`#${desc}`)).toBeVisible();
  expect(await axeGraves(page), 'errores').toEqual([]);

  const telefono = '8134567890';
  await llenarDatos(page, { telefono });
  await expect(page.getByRole('heading', { name: /Selecciona día y hora/ })).toBeFocused();
  await elegirHorario(page);
  expect(await axeGraves(page), 'horario').toEqual([]);
  if (esMovil(page)) await usableEnMovil(page, '#postularme');

  await botonEnviarCodigo(page).click();
  const otp = page.getByLabel('Código de verificación');
  await expect(otp).toBeVisible();
  await expect(otp).toHaveAttribute('inputmode', 'numeric');
  await expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
  expect(await axeGraves(page), 'OTP').toEqual([]);
  if (esMovil(page)) await usableEnMovil(page, '#postularme');

  await escribirOtp(page, await esperarOtp(proveedores, telefono));
  await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeFocused();
  expect(await axeGraves(page), 'pase').toEqual([]);
  if (esMovil(page)) await usableEnMovil(page, '#postularme');
});

test('vacante: respaldo a WhatsApp cuando el backend falla', async ({ page, backend }) => {
  backend.responder('postular', () => ({ estado: 500, cuerpo: { error: 'ERROR_INTERNO', fallback_whatsapp: true } }));
  await page.goto(LANDING);
  await decidirCookies(page, 'Rechazar');
  await llenarDatos(page, { telefono: '8134567891' });
  await elegirHorario(page);
  await botonEnviarCodigo(page).click();
  await expect(page.getByRole('heading', { name: 'No pudimos completar tu registro en línea' })).toBeFocused();
  expect(await axeGraves(page)).toEqual([]);
});

test('panel: todas las vistas con sesión de admin', async ({ page, backend }) => {
  const cita = backend.sembrarCita(IDS.vacanteA, '2026-11-18T16:00:00.000Z');
  await entrarAlPanel(page, USUARIOS.admin);
  expect(await axeGraves(page), 'vacantes').toEqual([]);
  for (const [ruta, h1] of [
    [`/panel/vacante/?id=${IDS.vacanteA}`, 'Reglas de la vacante'],
    ['/panel/agenda/?fecha=2026-11-18', 'Agenda'],
    [`/panel/citas/?id=${cita.id}`, 'Detalle de la cita'],
    ['/panel/dashboard/', 'Dashboard'],
    ['/panel/admin/', 'Alta de clientes y vacantes'],
  ] as const) {
    await page.goto(ruta);
    await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Cargando…' })).toHaveCount(0);
    expect(await axeGraves(page), ruta).toEqual([]);
    if (esMovil(page)) {
      const ancho = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(ancho, `${ruta} sin scroll horizontal de página`).toBeLessThanOrEqual(1);
    }
  }
});

test('panel: acceso sin sesión y establecer contraseña', async ({ page }) => {
  await page.goto('/panel/');
  await expect(page.getByLabel('Correo')).toBeVisible();
  expect(await axeGraves(page), 'login').toEqual([]);
  if (esMovil(page)) await usableEnMovil(page, 'main');
  await page.goto(`/panel/acceso/#access_token=${jwtDe(USUARIOS.reclutadorA)}&expires_in=3600&refresh_token=r&token_type=bearer&type=invite`);
  await expect(page.getByLabel('Contraseña nueva')).toBeVisible();
  expect(await axeGraves(page), 'acceso').toEqual([]);
  if (esMovil(page)) await usableEnMovil(page, 'main');
});

test('cita: cancelar y reprogramar desde el link', async ({ page, backend }) => {
  const cita = backend.sembrarCita(IDS.vacanteA, '2026-11-19T16:00:00.000Z');
  for (const accion of ['cancelar', 'reprogramar'] as const) {
    await page.goto(`/cita/?t=${await backend.linkGestion(cita.id, accion)}`);
    await expect(page.getByRole('heading', { level: 1, name: accion === 'cancelar' ? 'Cancelar tu cita' : 'Reprogramar tu cita' })).toBeVisible();
    expect(await axeGraves(page), accion).toEqual([]);
    if (esMovil(page)) await usableEnMovil(page, 'main');
  }
});
