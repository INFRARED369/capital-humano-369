/** Pasos reutilizables del recorrido del candidato y utilidades de accesibilidad para los E2E. */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import type { MocksProveedores } from './proveedores';

export const LANDING = '/vacantes/agente-smart/';

/**
 * axe con WCAG 2.1 A/AA: solo violaciones serias o críticas (NFR-A11Y-01). `preload: false` evita que axe
 * descargue por XHR las hojas de estilo externas (Google Fonts), que la CSP bloquea con razón en connect-src.
 */
export async function axeGraves(page: Page): Promise<string[]> {
  // Medir contraste a mitad de una transición de color da falsos positivos (CI lento): esperar las finitas.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
    new Promise((r) => setTimeout(r, 2000)),
  ]));
  const { violations } = await new AxeBuilder({ page }).options({ preload: false }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length} nodos: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')})`);
}

export async function decidirCookies(page: Page, decision: 'Aceptar' | 'Rechazar'): Promise<void> {
  const banner = page.getByRole('dialog', { name: 'Tu privacidad' });
  await banner.getByRole('button', { name: decision, exact: true }).click();
  await expect(banner).toBeHidden();
}

export interface DatosCandidato { nombre?: string; telefono: string; respuestas?: 'si' | 'no'; /** false si se espera el respaldo (backend caído) en lugar del paso de horario. */ esperarHorario?: boolean }

/** Paso 1: datos + preguntas del perfil + consentimiento → "Continuar". */
export async function llenarDatos(page: Page, d: DatosCandidato): Promise<void> {
  const form = page.locator('#postularme form');
  await page.locator('#campo-nombre').fill(d.nombre ?? 'Mariana Garza López');
  await page.locator('#campo-telefono').fill(d.telefono);
  await page.locator('#campo-edad').fill('24');
  for (const sel of await form.locator('select').all()) await sel.selectOption({ index: d.respuestas === 'no' ? 2 : 1 });
  const nombres = new Set(await form.locator('input[type=radio]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).name)));
  for (const n of nombres) await form.locator(`input[type=radio][name="${n}"][value="${d.respuestas ?? 'si'}"]`).check();
  await page.locator('#campo-consentimiento').check();
  await page.getByRole('button', { name: /Continuar: elegir día y hora/ }).click();
  if (d.esperarHorario !== false) await expect(page.getByRole('heading', { name: /Selecciona día y hora/ })).toBeVisible();
}

/** Paso 2: espera los horarios de citas-api, elige día y hora (por índice o texto). Devuelve la etiqueta de la hora. */
export async function elegirHorario(page: Page, o: { dia?: number; hora?: number | string } = {}): Promise<string> {
  const dias = page.getByRole('group', { name: /Día disponible/ }).getByRole('button');
  await expect(dias.first()).toBeVisible();
  await dias.nth(o.dia ?? 0).click();
  const horas = page.getByRole('group', { name: /Horario de entrevista/ }).getByRole('button');
  const boton = typeof o.hora === 'string' ? horas.filter({ hasText: o.hora }).first() : horas.nth(o.hora ?? 0);
  const etiqueta = (await boton.textContent())?.trim() ?? '';
  await boton.click();
  await expect(boton).toHaveAttribute('aria-pressed', 'true');
  return etiqueta;
}

export const botonEnviarCodigo = (page: Page) => page.getByRole('button', { name: /Enviar código por WhatsApp/ });

/** Último código OTP que el sistema envió por WhatsApp (mock de Evolution) al teléfono de 10 dígitos. */
export function codigoOtp(proveedores: MocksProveedores, telefono10: string): string {
  const envio = proveedores
    .llamadas('evolution')
    .filter((l) => l.ruta.includes('/message/sendText/') && (l.cuerpo as { number?: string }).number === `52${telefono10}`)
    .map((l) => /código de verificación.*? es (\d{6})/.exec((l.cuerpo as { text: string }).text)?.[1])
    .filter((c): c is string => !!c)
    .at(-1);
  if (!envio) throw new Error(`no se envió OTP a ${telefono10}`);
  return envio;
}

/** Espera a que el worker de Comunicación entregue el OTP en el mock de Evolution. */
export async function esperarOtp(proveedores: MocksProveedores, telefono10: string, previos = 0): Promise<string> {
  let codigo = '';
  await expect
    .poll(() => {
      const n = proveedores.llamadas('evolution').filter((l) => /código de verificación/.test(String((l.cuerpo as { text?: string })?.text)) && (l.cuerpo as { number?: string }).number === `52${telefono10}`).length;
      if (n > previos) codigo = codigoOtp(proveedores, telefono10);
      return n > previos;
    })
    .toBe(true);
  return codigo;
}

export async function escribirOtp(page: Page, codigo: string): Promise<void> {
  await page.getByLabel('Código de verificación').fill(codigo);
  await page.getByRole('button', { name: /Verificar y generar mi pase/ }).click();
}

/** Recorrido completo hasta el paso OTP (sin verificar). */
export async function postularHastaOtp(page: Page, d: DatosCandidato & { hora?: number | string; dia?: number }): Promise<string> {
  await llenarDatos(page, d);
  const hora = await elegirHorario(page, d);
  await botonEnviarCodigo(page).click();
  await expect(page.getByRole('heading', { name: /Verifica tu contacto/ })).toBeVisible();
  return hora;
}

/** Candidato completo: landing → datos → horario → OTP (del mock de Evolution) → pase. Devuelve el folio. */
export async function agendarComoCandidato(page: Page, proveedores: MocksProveedores, d: DatosCandidato & { dia?: number; hora?: number | string; cookies?: 'Aceptar' | 'Rechazar' }): Promise<string> {
  await page.goto(LANDING);
  await decidirCookies(page, d.cookies ?? 'Rechazar');
  await postularHastaOtp(page, d);
  await escribirOtp(page, await esperarOtp(proveedores, d.telefono));
  await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeVisible();
  return (await page.locator('.pass-folio strong').textContent()) ?? '';
}

/** Inicia sesión en el panel con un usuario simulado y espera la lista de vacantes. */
/** Cierra sesión y espera a que termine (signOut es asíncrono: navegar antes conserva la sesión en CI lento). */
export async function salirDelPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acceso al panel' })).toBeVisible();
}

export async function entrarAlPanel(page: Page, u: { email: string; password: string }): Promise<void> {
  await page.goto('/panel/');
  await page.getByLabel('Correo').fill(u.email);
  await page.getByLabel('Contraseña').fill(u.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Vacantes' })).toBeVisible();
}

/** Ruta local (sin host) de un link absoluto del sistema (Zoho, WhatsApp). */
export const rutaDe = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}${u.hash}`;
};
