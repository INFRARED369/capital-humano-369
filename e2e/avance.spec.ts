/**
 * Avance del candidato: si recarga, vuelve al mismo paso con los mismos datos (sessionStorage, 2 h).
 */
import { LANDING, botonEnviarCodigo, decidirCookies, elegirHorario, escribirOtp, esperarOtp, expect, llenarDatos, test } from './fixtures';

test.describe('avance guardado al recargar', () => {
  test('datos → horario → OTP → pase: cada recarga vuelve al mismo paso y con los mismos datos', async ({ page, proveedores }) => {
    const telefono = '8115551234';
    await page.goto(LANDING);
    await decidirCookies(page, 'Rechazar');

    // Paso 1 a medias: lo escrito sobrevive a la recarga.
    await page.locator('#campo-nombre').fill('Mariana Garza López');
    await page.locator('#campo-telefono').fill(telefono);
    await page.locator('#campo-email').fill('mariana@correo.mx');
    await page.reload();
    await expect(page.locator('#campo-nombre')).toHaveValue('Mariana Garza López');
    await expect(page.locator('#campo-telefono')).toHaveValue(telefono);
    await expect(page.locator('#campo-email')).toHaveValue('mariana@correo.mx');

    // Paso 2 con día, hora y canal elegidos.
    await llenarDatos(page, { telefono });
    const hora = await elegirHorario(page, { dia: 1, hora: 1 });
    await page.getByRole('radio', { name: /Correo/ }).check();
    await page.reload();
    await expect(page.getByRole('heading', { name: /Selecciona día y hora/ })).toBeVisible();
    await expect(page.getByText('Recuperamos tu avance: continúa donde te quedaste.')).toBeVisible();
    await expect(page.getByRole('group', { name: /Horario de entrevista/ }).getByRole('button', { name: hora, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('radio', { name: /Correo/ })).toBeChecked();
    await expect(page.locator('.canal-otp .otp-destino')).toHaveText('Enviaremos el código a mariana@correo.mx');

    // Paso 3: el OTP sigue pendiente tras recargar y se puede verificar.
    await page.getByRole('radio', { name: 'WhatsApp' }).check();
    await botonEnviarCodigo(page).click();
    await expect(page.getByRole('heading', { name: /Verifica tu contacto/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: /Verifica tu contacto/ })).toBeVisible();
    await expect(page.locator('.otp-destino-enviado')).toHaveText('Código enviado por WhatsApp a +52 81 1555 1234');
    await escribirOtp(page, await esperarOtp(proveedores, telefono));
    await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeVisible();

    // El pase también sobrevive a la recarga (para imprimirlo o volver a verlo).
    const folio = await page.locator('.pass-folio strong').textContent();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeVisible();
    await expect(page.locator('.pass-folio strong')).toHaveText(folio!);
    await expect(page.getByText('Mariana Garza López')).toBeVisible();
  });
});
