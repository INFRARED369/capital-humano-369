/**
 * Recorridos del candidato sobre out/ con el backend simulado (fixtures/backend.ts) y los mocks de proveedores:
 * E2E-01 (recorrido completo con UTM y consentimiento), E2E-02 (todo "no"), E2E-03 (rechaza cookies),
 * E2E-04 (dos navegadores por el último lugar), E2E-05 (retención vence con reloj simulado),
 * E2E-06 (OTP incorrecto 5 veces) y E2E-07 (Zoho caído durante la confirmación).
 */
import type { Page } from '@playwright/test';
import {
  CALENDARIO_A, IDS, LANDING, axeGraves, botonEnviarCodigo, decidirCookies, elegirHorario, escribirOtp, esperarOtp, expect, llenarDatos, postularHastaOtp, test,
} from './fixtures';

const UTM = 'utm_source=facebook&utm_medium=paid_social&utm_campaign=agente-smart-nov&utm_content=video-a&fbclid=IwAR-e2e-123';

/** Llamadas a fbq que hizo la página (cola del SDK antes de cargar fbevents.js). */
const colaPixel = (page: Page) => page.evaluate(() => ((window as unknown as { fbq?: { queue?: unknown[][] } }).fbq?.queue ?? []) as unknown[][]);

test.describe('candidato', () => {
  test('E2E-01: anuncio con UTM → cookies → video → CTA → formulario → slot → OTP → pase; Schedule solo en servidor', async ({ page, backend, terceros, proveedores }) => {
    test.slow(); // recorrido completo con varios análisis axe: holgura ante CPU compartida en CI
    await page.goto(`${LANDING}?${UTM}`);
    await decidirCookies(page, 'Aceptar');

    // TRK-01/02: tras aceptar se cargan Pixel y Clarity (enmascarado total) y las cookies first-party.
    await expect.poll(() => terceros.solicitudes.meta.length).toBeGreaterThan(0);
    await expect.poll(() => terceros.solicitudes.clarity.length).toBeGreaterThan(0);
    await expect(page.locator('html')).toHaveAttribute('data-clarity-mask', 'true');
    const cookies = Object.fromEntries((await page.context().cookies()).map((c) => [c.name, decodeURIComponent(c.value)]));
    expect(cookies['_369_consent']).toMatch(/\|a$/);
    expect(cookies['_369_vid']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(cookies['_369_attr']!)).toMatchObject({ utm_source: 'facebook', utm_campaign: 'agente-smart-nov', fbclid: 'IwAR-e2e-123' });
    expect(cookies['_fbc']).toMatch(/^fb\.1\.\d+\.IwAR-e2e-123$/);

    // Video (VideoPlay) y CTA (ClickCTA) → ingesta con consentimiento y UTM.
    await page.getByRole('button', { name: 'Reproducir invitación' }).click();
    await page.getByRole('link', { name: /Postularme y Agendar Entrevista/ }).click();
    await expect.poll(() => backend.ingesta.filter((e) => e.nombre === 'ClickCTA').length).toBeGreaterThan(0);
    const cta = backend.ingesta.find((e) => e.nombre === 'ClickCTA')!;
    expect(cta).toMatchObject({ consentimiento: true, atribucion: { utm_source: 'facebook', utm_campaign: 'agente-smart-nov' }, custom_data: { vacancy_id: 'agente-smart' } });

    const telefono = '8112345678';
    await llenarDatos(page, { nombre: 'Mariana Garza López', telefono });
    expect(await axeGraves(page), 'axe en el paso de horario').toEqual([]);
    await elegirHorario(page, { dia: 2 }); // pasado mañana: los recordatorios de 24 h y 2 h quedan en el futuro
    await botonEnviarCodigo(page).click();
    await expect(page.getByRole('heading', { name: /Verifica tu contacto/ })).toBeVisible();

    // POST postular: event_id = event_id del Pixel Lead, vacante, atribución UTM, sin campos de más.
    const post = backend.llamadas('postular')[0]!.cuerpo as Record<string, unknown> & { event_id: string; atribucion: Record<string, string> };
    expect(post).toMatchObject({ vacante: 'agente-smart', consentimiento: { aceptado: true } });
    expect(post.atribucion).toMatchObject({ utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'agente-smart-nov', fbclid: 'IwAR-e2e-123', visitor_id: cookies['_369_vid'] });
    const lead = (await colaPixel(page)).find((a) => a[0] === 'track' && a[1] === 'Lead');
    expect(lead, 'Pixel Lead').toBeTruthy();
    expect((lead![3] as { eventID: string }).eventID).toBe(post.event_id);
    expect(lead![2]).toMatchObject({ vacancy_id: 'agente-smart', content_category: 'telecomunicaciones' });

    expect(await axeGraves(page), 'axe en el paso OTP').toEqual([]);
    const codigo = await esperarOtp(proveedores, telefono);
    await escribirOtp(page, codigo);
    await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeVisible();
    const folio = (await page.locator('.pass-folio strong').textContent())!;
    expect(folio).toMatch(/^369-[A-Z0-9]{6}$/);
    expect(await axeGraves(page), 'axe en el pase').toEqual([]);

    // T8: Schedule (CitaConfirmada) jamás sale del navegador.
    expect((await colaPixel(page)).some((a) => a[1] === 'Schedule')).toBe(false);
    expect(backend.ingesta.some((e) => e.nombre === 'Schedule' || e.nombre === 'CitaConfirmada')).toBe(false);
    expect(terceros.solicitudes.meta.some((u) => /Schedule/.test(u))).toBe(false);
    // Sin PII hacia la ingesta.
    expect(JSON.stringify(backend.ingesta)).not.toMatch(/8112345678|Mariana/);

    // Servidor: cita confirmada → Schedule en CAPI con vacancy_id, evento en Zoho y confirmación encolada/enviada.
    await backend.procesarColas();
    const cita = backend.citas.find((c) => c.estado === 'confirmada' && c.vacante_id === IDS.vacanteA)!;
    expect(cita).toBeTruthy();
    const capi = proveedores.llamadas('meta').flatMap((l) => (l.cuerpo as { data: Array<Record<string, unknown>> }).data);
    const schedule = capi.find((e) => e.event_name === 'Schedule')!;
    expect(schedule).toMatchObject({ action_source: 'website', custom_data: { vacancy_id: IDS.vacanteA, client_id: IDS.clienteA } });
    expect((schedule.user_data as { ph: string[] }).ph[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(capi.find((e) => e.event_name === 'Lead')?.event_id, 'Lead CAPI deduplica con el Pixel').toBe(post.event_id);
    const zoho = proveedores.llamadas('zoho').find((l) => l.metodo === 'POST')!;
    expect(zoho.ruta).toBe(`/api/v1/calendars/${CALENDARIO_A}/events`);
    const ev = (zoho.cuerpo as { eventdata: { title: string; description: string; attendees: unknown[] } }).eventdata;
    expect(ev.title).toBe(`Entrevista ${folio} · Mariana`);
    expect(ev.description).toContain(`/panel/citas/?id=${cita.id}`);
    expect(JSON.stringify(ev)).not.toContain('8112345678');
    expect(ev.attendees).toEqual([]);
    expect(backend.mensajes.find((m) => m.tipo === 'confirmacion')?.estado).toBe('enviado');
    expect(backend.mensajes.filter((m) => m.tipo.startsWith('recordatorio')).map((m) => m.estado)).toEqual(['pendiente', 'pendiente']);
    expect(terceros.erroresPagina).toEqual([]);
    expect(terceros.violacionesCsp).toEqual([]);
  });

  test('E2E-02: responde "no" a todo → lead, Lead, OTP y agenda (sin pantalla de rechazo)', async ({ page, backend, proveedores }) => {
    await page.goto(LANDING);
    await decidirCookies(page, 'Aceptar');
    const telefono = '8111111111';
    await postularHastaOtp(page, { telefono, respuestas: 'no' });
    const post = backend.llamadas('postular')[0]!.cuerpo as { respuestas: Record<string, string>; event_id: string };
    expect(Object.values(post.respuestas).filter((v) => v === 'no').length).toBeGreaterThanOrEqual(3);
    expect(backend.eventos('LeadCreado')).toHaveLength(1);
    expect((await colaPixel(page)).some((a) => a[1] === 'Lead')).toBe(true);
    await escribirOtp(page, await esperarOtp(proveedores, telefono));
    await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeVisible();
    await expect(page.getByText(/no cumples|rechaz|no calificas/i)).toHaveCount(0);
  });

  test('E2E-03: rechaza cookies → sin Clarity ni Meta, sin cookies de marketing; el flujo sigue funcionando', async ({ page, backend, terceros, proveedores }) => {
    await page.goto(`${LANDING}?${UTM}`);
    await decidirCookies(page, 'Rechazar');
    const telefono = '8122222222';
    await postularHastaOtp(page, { telefono });
    await escribirOtp(page, await esperarOtp(proveedores, telefono));
    await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeVisible();

    expect(terceros.solicitudes.meta, 'connect.facebook.net').toEqual([]);
    expect(terceros.solicitudes.clarity, 'Clarity').toEqual([]);
    expect(await page.evaluate(() => typeof (window as unknown as { fbq?: unknown }).fbq)).toBe('undefined');
    expect(await page.locator('html').getAttribute('data-clarity-mask')).toBeNull();
    const nombres = (await page.context().cookies()).map((c) => c.name);
    expect(nombres.filter((n) => ['_369_vid', '_369_attr', '_fbp', '_fbc'].includes(n))).toEqual([]);
    // Solo conteo anónimo: sin visitor_id ni click ids; la atribución del POST va vacía de identificadores.
    expect(backend.ingesta.length).toBeGreaterThan(0);
    expect(backend.ingesta.every((e) => e.consentimiento === false && !('visitor_id' in e))).toBe(true);
    expect(JSON.stringify(backend.ingesta)).not.toContain('IwAR-e2e-123');
    expect((backend.llamadas('postular')[0]!.cuerpo as { atribucion?: Record<string, string> }).atribucion?.visitor_id).toBeUndefined();
    // Servidor: sin consentimiento no hay envíos a Meta.
    await backend.procesarColas();
    expect(proveedores.llamadas('meta')).toEqual([]);
  });

  test('E2E-04: dos navegadores van por el último lugar → uno retiene, el otro ve "elige otro horario"', async ({ page, backend, otroNavegador }) => {
    // Un solo inicio en todo el horizonte: mañana 10:00 (hoy queda dentro de la antelación mínima).
    backend.fijarAgenda(IDS.vacanteA, { ventanas_inicio: [{ desde: '10:00', hasta: '10:00' }], horizonte_dias: 2, dias_habiles: [1, 2, 3, 4, 5, 6, 7] });
    expect(backend.slotsLibres(IDS.vacanteA)).toHaveLength(1);
    const b = await otroNavegador();
    for (const [p, tel] of [[page, '8133333333'], [b.page, '8144444444']] as const) {
      await p.goto(LANDING);
      await decidirCookies(p, 'Rechazar');
      await llenarDatos(p, { telefono: tel });
      await elegirHorario(p);
    }
    await Promise.all([botonEnviarCodigo(page).click(), botonEnviarCodigo(b.page).click()]);

    const pasoOtp = (p: Page) => p.getByRole('heading', { name: /Verifica tu contacto/ });
    await expect.poll(async () => (await pasoOtp(page).count()) + (await pasoOtp(b.page).count())).toBe(1);
    const perdedor = (await pasoOtp(page).count()) ? b.page : page;
    await expect(perdedor.getByText('Ese horario se acaba de ocupar. Elige otro.')).toBeVisible();
    await expect(perdedor.getByText(/no hay horarios disponibles/)).toBeVisible();
    const respuestas = backend.llamadas('postular').length;
    expect(respuestas).toBe(2);
    expect(backend.citas.filter((c) => c.estado === 'retenida')).toHaveLength(1);
    expect(await axeGraves(perdedor)).toEqual([]);
  });

  test('E2E-05: no ingresa el OTP y pasan 10 min (reloj simulado) → el slot vuelve a estar disponible', async ({ page, backend, otroNavegador }) => {
    await page.clock.install({ time: backend.ahora() });
    await page.goto(LANDING);
    await decidirCookies(page, 'Rechazar');
    // Mañana (día 2): con la antelación mínima de 2 h, un horario de hoy podría dejar de ofrecerse al avanzar el reloj.
    const hora = await postularHastaOtp(page, { telefono: '8155555555', dia: 1 });
    const retenida = backend.citas.find((c) => c.estado === 'retenida')!;
    await expect(page.getByText(/el código vence a las 9:10/)).toBeVisible();

    // Otro candidato no ve el horario retenido.
    const b = await otroNavegador();
    await b.page.clock.install({ time: backend.ahora() });
    await b.page.goto(LANDING);
    await decidirCookies(b.page, 'Rechazar');
    await llenarDatos(b.page, { telefono: '8166666666' });
    await b.page.getByRole('group', { name: /Día disponible/ }).getByRole('button').nth(1).click();
    const grupoHoras = b.page.getByRole('group', { name: /Horario de entrevista/ });
    await expect(grupoHoras.getByRole('button').first()).toBeVisible();
    await expect(grupoHoras.getByRole('button', { name: hora, exact: true })).toHaveCount(0);

    // Pasan 10 minutos y 1 segundo (navegadores y servidor).
    const diez = 10 * 60_000 + 1000;
    backend.avanzar(diez);
    await page.clock.fastForward(diez);
    await b.page.clock.fastForward(diez);
    await b.page.getByRole('button', { name: '← Cambiar mis datos' }).click();
    await b.page.getByRole('button', { name: /Continuar: elegir día y hora/ }).click();
    await b.page.getByRole('group', { name: /Día disponible/ }).getByRole('button').nth(1).click();
    await expect(grupoHoras.getByRole('button', { name: hora, exact: true })).toBeVisible();
    expect(backend.cita(retenida.id)?.estado).toBe('expirada');

    // El primer candidato ya no puede confirmar con ese código: se le pide uno nuevo.
    await escribirOtp(page, '123456');
    await expect(page.getByText('El código venció. Pide uno nuevo.')).toBeVisible();
    // Reenviar ya no sirve: la retención venció (409 RETENCION_EXPIRADA) → vuelve a elegir horario.
    await page.getByRole('button', { name: /Reenviar por WhatsApp/ }).click();
    await expect(page.getByRole('heading', { name: /Selecciona día y hora/ })).toBeVisible();
    await expect(page.getByText('Tu horario expiró mientras verificabas. Elige uno nuevo.')).toBeVisible();
    expect(backend.llamadas('verificar-otp').at(-1)?.url).toMatch(/\/verificar-otp\/reenviar$/);
  });

  test('E2E-06: OTP incorrecto 5 veces → bloqueo con mensaje claro y el horario se libera', async ({ page, backend, proveedores }) => {
    await page.goto(LANDING);
    await decidirCookies(page, 'Rechazar');
    const telefono = '8177777777';
    await postularHastaOtp(page, { telefono });
    const real = await esperarOtp(proveedores, telefono);
    const malo = real === '000000' ? '111111' : '000000';
    for (let i = 4; i >= 1; i--) {
      await escribirOtp(page, malo);
      await expect(page.getByText(`Código incorrecto. Te quedan ${i} intentos.`)).toBeVisible();
    }
    await escribirOtp(page, malo);
    await expect(page.getByText(/Bloqueamos la verificación por demasiados intentos y liberamos tu horario/)).toBeVisible();
    expect(await axeGraves(page)).toEqual([]);
    // Ni el código correcto sirve ya; la retención quedó liberada.
    await escribirOtp(page, real);
    await expect(page.getByText(/Bloqueamos la verificación/)).toBeVisible();
    expect(backend.citas.filter((c) => c.estado === 'retenida')).toEqual([]);
    expect(backend.citas.some((c) => c.estado === 'expirada' && c.motivo === 'OTP_BLOQUEADO')).toBe(true);
    expect(backend.eventos('CitaConfirmada')).toEqual([]);
  });

  test('E2E-07: Zoho caído durante la confirmación → el candidato no lo nota; el evento aparece cuando Zoho vuelve', async ({ page, backend, proveedores }) => {
    proveedores.fallar('zoho', 2);
    await page.goto(LANDING);
    await decidirCookies(page, 'Rechazar');
    const telefono = '8188888888';
    await postularHastaOtp(page, { telefono });
    await escribirOtp(page, await esperarOtp(proveedores, telefono));
    await expect(page.getByRole('heading', { name: 'PASE DE ENTREVISTA', exact: true })).toBeVisible();
    await expect(page.locator('.form-alert')).toHaveCount(0);

    await backend.procesarColas();
    const cita = backend.citas.find((c) => c.estado === 'confirmada' && c.vacante_id === IDS.vacanteA)!;
    const trabajo = () => backend.trabajos.find((t) => t.cola === 'zoho' && t.datos.cita_id === cita.id)!;
    expect(trabajo()).toMatchObject({ estado: 'pendiente', intentos: 1 });
    expect(cita.zoho_event_uid).toBeNull();
    expect(backend.mensajes.find((m) => m.tipo === 'confirmacion')?.estado, 'la confirmación no depende de Zoho').toBe('enviado');

    backend.avanzar(30_000); // backoff 1
    await backend.procesarColas();
    expect(trabajo()).toMatchObject({ estado: 'pendiente', intentos: 2 });
    backend.avanzar(60_000); // backoff 2: Zoho ya volvió
    await backend.procesarColas();
    expect(trabajo()).toMatchObject({ estado: 'hecho', intentos: 3 });
    expect(backend.cita(cita.id)?.zoho_event_uid).toMatch(/^zev-/);
    expect(backend.cita(cita.id)?.estado).toBe('confirmada');
    expect(proveedores.llamadas('zoho').filter((l) => l.metodo === 'POST')).toHaveLength(3);
  });
});
