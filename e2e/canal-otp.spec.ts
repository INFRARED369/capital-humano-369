/**
 * Canal del código de verificación: el candidato elige WhatsApp, SMS o correo, puede cambiar de canal
 * en cada reenvío y siempre ve a qué número o correo se envía el código.
 */
import { LANDING, botonEnviarCodigo, decidirCookies, elegirHorario, expect, llenarDatos, test } from './fixtures';

test.describe('canal del OTP', () => {
  test('número sin WhatsApp → se queda en el paso, propone SMS; luego cambia a correo al reenviar', async ({ page, backend }) => {
    await page.goto(LANDING);
    await decidirCookies(page, 'Rechazar');
    // El mock de Evolution responde "no existe" para números que terminan en 0000.
    await llenarDatos(page, { telefono: '8112340000' });
    await elegirHorario(page);

    const destino = page.locator('.canal-otp .otp-destino');
    await expect(page.getByRole('radio', { name: 'WhatsApp' })).toBeChecked();
    await expect(destino).toHaveText('Enviaremos el código a +52 81 1234 0000');
    await botonEnviarCodigo(page).click();

    // No cierra la puerta: sigue en el horario, con SMS preseleccionado y el mismo destino visible.
    await expect(page.getByText(/no tiene WhatsApp\. Elige recibir el código por SMS o por correo/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Selecciona día y hora/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /SMS/ })).toBeChecked();
    await expect(destino).toHaveText('Enviaremos el código a +52 81 1234 0000');

    // Correo sin email capturado: pide el correo y muestra a dónde irá.
    await page.getByRole('radio', { name: /Correo/ }).check();
    await expect(destino).toHaveText('Escribe el correo al que enviaremos el código.');
    await page.locator('#campo-email-otp').fill('mariana@correo.mx');
    await expect(destino).toHaveText('Enviaremos el código a mariana@correo.mx');

    // Regresa a SMS y envía.
    await page.getByRole('radio', { name: /SMS/ }).check();
    await page.getByRole('button', { name: /Enviar código por SMS/ }).click();
    await expect(page.getByRole('heading', { name: /Verifica tu contacto/ })).toBeVisible();
    await expect(page.locator('.otp-destino-enviado')).toHaveText('Código enviado por SMS a +52 81 1234 0000');
    expect(backend.llamadas('postular').at(-1)?.cuerpo).toMatchObject({ canal_otp: 'sms' });

    // Cambia a correo en el reenvío: muestra el correo, permite corregirlo y lo usa como destino.
    await page.getByRole('button', { name: /Enviar por correo a mariana@correo\.mx/ }).click();
    await page.locator('#campo-email-reenvio').fill('mariana.garza@correo.mx');
    await page.getByRole('button', { name: 'Enviar código a este correo' }).click();
    await expect(page.locator('.otp-destino-enviado')).toHaveText('Código enviado por correo a mariana.garza@correo.mx');
    expect(backend.llamadas('verificar-otp').at(-1)?.cuerpo).toMatchObject({ canal: 'email', email: 'mariana.garza@correo.mx' });
    await expect(page.getByRole('button', { name: /Reenviar por correo/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Enviar por WhatsApp a \+52 81 1234 0000/ })).toBeVisible();
  });
});
