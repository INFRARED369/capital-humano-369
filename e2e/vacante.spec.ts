/**
 * E2E-12 · Regresión de /vacantes/agente-smart/ (URL de campañas, CAP-01): 200, contenido clave, video, secciones,
 * interacciones (FAQ, calculadora, menú de vacantes), respaldo a WhatsApp si el backend cae (CAP-10).
 * El 301 sin barra final con query y el axe base están en smoke.spec.ts.
 */
import { IDS, LANDING, decidirCookies, expect, llenarDatos, test } from './fixtures';

test('E2E-12: 200 y contenido clave de la landing de Agente Smart', async ({ page, request, terceros }) => {
  const res = await page.goto(LANDING);
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle('Vacante: Agente Smart (Telecomunicaciones) | Capital Humano 369');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Agente Smart');
  for (const id of ['inicio', 'beneficios', 'requisitos', 'ubicacion', 'postularme', 'faq']) await expect(page.locator(`#${id}`)).toHaveCount(1);
  await expect(page.getByRole('link', { name: /Postularme y Agendar Entrevista/ })).toHaveAttribute('href', '#postularme');
  await expect(page.locator('a[href^="https://wa.me/528119942627"]').first()).toBeAttached();
  await expect(page.locator('a[href="/aviso-de-privacidad/"]').first()).toBeAttached();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /\S/);

  // Video: existe, no se descarga completo al cargar (preload) y el archivo se sirve.
  const video = page.locator('video.recruitment-video-el');
  await expect(video.locator('source')).toHaveAttribute('src', '/vacantes/agente-smart/Agente_Smart_VF.mp4');
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video).toHaveAttribute('poster', '/vacantes/agente-smart/poster.webp');
  expect((await request.get('/vacantes/agente-smart/poster.webp')).status()).toBe(200);
  const mp4 = await request.head('/vacantes/agente-smart/Agente_Smart_VF.mp4');
  expect(mp4.status()).toBe(200);
  expect(mp4.headers()['content-type']).toMatch(/video\/mp4/);

  // FAQ accesible (aria-expanded) y calculadora con resultado en vivo.
  const faq = page.getByRole('button', { name: /Cuánto se puede ganar en total/ });
  const inicial = await faq.getAttribute('aria-expanded');
  expect(inicial).toMatch(/^(true|false)$/);
  await faq.click();
  await expect(faq).toHaveAttribute('aria-expanded', inicial === 'true' ? 'false' : 'true');
  await expect(page.locator(`#${await faq.getAttribute('aria-controls')}`)).toBeAttached();
  const slider = page.getByLabel('Comisión semanal estimada:');
  const antes = await page.locator('.calc-breakdown').textContent();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.calc-breakdown')).not.toHaveText(antes ?? '');

  // Menú "Vacantes Premium" enlaza a sí misma.
  await expect(page.locator('#menu-vacantes a[href="/vacantes/agente-smart/"]')).toHaveAttribute('aria-current', 'page');
  expect(terceros.erroresPagina).toEqual([]);
  expect(terceros.violacionesCsp).toEqual([]);
});

test('E2E-12 / CAP-10: si citas-api cae, el candidato ve el respaldo a WhatsApp con sus datos', async ({ page, backend }) => {
  backend.responder('citas-api', () => ({ estado: 503, cuerpo: { error: 'ERROR_INTERNO', fallback_whatsapp: true } }));
  await page.goto(LANDING);
  await decidirCookies(page, 'Rechazar');
  await llenarDatos(page, { telefono: '8123456789', nombre: 'Rosa Medina', esperarHorario: false });
  await expect(page.getByRole('heading', { name: 'No pudimos completar tu registro en línea' })).toBeVisible();
  const wa = page.getByRole('link', { name: /Enviar mi postulación por WhatsApp/ });
  const href = decodeURIComponent((await wa.getAttribute('href')) ?? '');
  expect(href).toMatch(/^https:\/\/wa\.me\/528119942627\?text=/);
  expect(href).toContain('Rosa Medina');
  expect(backend.citas.filter((c) => c.vacante_id === IDS.vacanteA)).toEqual([]);
});

test('F7.4: vacante con agenda por WhatsApp → sin pantalla de horarios; wa.me con referencia (sin PII de más) y ClickCTA', async ({ page, backend, terceros }) => {
  backend.fijarAgendaModo(IDS.vacanteA, 'whatsapp');
  await page.context().route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: 'wa.me (stub e2e)' }));
  await page.goto(LANDING);
  await decidirCookies(page, 'Aceptar');
  await llenarDatos(page, { telefono: '8123456789', nombre: 'Rosa Medina Treviño', esperarHorario: false });

  await expect(page.getByRole('heading', { name: /Agenda tu entrevista por WhatsApp/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Selecciona día y hora/ })).toHaveCount(0);
  await expect(page.getByText(/no hay horarios disponibles/)).toHaveCount(0);
  const respuesta = backend.llamadas('citas-api').at(-1)!;
  expect(respuesta.url).toContain('vacante=agente-smart');

  const wa = page.getByRole('link', { name: /Agendar mi entrevista por WhatsApp/ });
  const href = decodeURIComponent((await wa.getAttribute('href')) ?? '');
  expect(href).toMatch(/^https:\/\/wa\.me\/528119942627\?text=/);
  expect(href).toContain('Agente Smart');
  expect(href).toContain('Mi nombre: Rosa');
  const referencia = /Referencia: (WA-[0-9A-F]{6})/.exec(href)?.[1];
  expect(referencia).toBeTruthy();
  expect(href).not.toMatch(/Medina|Treviño|8123456789|@/);

  const popup = page.waitForEvent('popup');
  await wa.click();
  await (await popup).close();
  await expect.poll(() => backend.ingesta.filter((e) => e.nombre === 'ClickCTA' && (e.props as { location?: string } | undefined)?.location === 'agenda_whatsapp').length).toBe(1);
  const cta = backend.ingesta.find((e) => e.nombre === 'ClickCTA' && (e.props as { location?: string } | undefined)?.location === 'agenda_whatsapp')!;
  // La referencia del mensaje sale del event_id del ClickCTA (correlación chat ↔ Pixel/CAPI sin PII).
  expect(String(cta.event_id).replace(/-/g, '').slice(-6).toUpperCase()).toBe(referencia!.slice(3));
  expect(JSON.stringify(backend.ingesta)).not.toMatch(/8123456789|Rosa/);

  // Sin postulación ni retención de slots del sistema.
  expect(backend.llamadas('postular')).toEqual([]);
  expect(backend.citas.filter((c) => c.vacante_id === IDS.vacanteA)).toEqual([]);
  expect(terceros.erroresPagina).toEqual([]);
  expect(terceros.violacionesCsp).toEqual([]);
});
