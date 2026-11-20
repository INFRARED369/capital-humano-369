/**
 * E2E del panel sobre out/ con el backend simulado (Supabase Auth + PostgREST con RLS por rol + panel-reglas +
 * citas-api con estado compartido). El RLS real se prueba en PGlite y pgTAP (S1, S3, S4).
 * Cubre: acceso/axe, E2E-08 (reglas → landing sin rebuild), E2E-09 (link del evento de Zoho → asistencia →
 * CAPI offline + agradecimiento), E2E-11 (aislamiento por rol), contratación, /panel/acceso/ (invitación y
 * recuperación) y la exclusión de Pixel/Clarity en el panel.
 */
import {
  IDS, LANDING, PASSWORD_E2E, USUARIOS, agendarComoCandidato, axeGraves, decidirCookies, entrarAlPanel, expect, jwtDe, llenarDatos, rutaDe, rutaExportada, test,
} from './fixtures';

test.beforeEach(() => {
  test.skip(!rutaExportada('/panel/') || !rutaExportada('/panel/acceso/'), 'el panel aún no está en out/ (npm run build)');
});

const horasLanding = (page: import('@playwright/test').Page) => page.getByRole('group', { name: /Horario de entrevista/ }).getByRole('button');

test.describe('/panel/', () => {
  test('sin sesión muestra el acceso; 200, noindex, sin errores de JS/CSP y axe sin violaciones graves', async ({ page, terceros }) => {
    const res = await page.goto('/panel/');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Acceso al panel' })).toBeVisible();
    await expect(page.getByLabel('Correo')).toBeVisible();
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toMatch(/noindex/);
    expect(await axeGraves(page)).toEqual([]);
    expect(terceros.erroresPagina).toEqual([]);
    expect(terceros.violacionesCsp).toEqual([]);
  });

  test('credenciales incorrectas → mensaje claro y sin sesión', async ({ page }) => {
    await page.goto('/panel/');
    await page.getByLabel('Correo').fill(USUARIOS.reclutadorA.email);
    await page.getByLabel('Contraseña').fill('equivocada-123');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByText('Correo o contraseña incorrectos.')).toBeVisible();
  });

  test('sin Pixel ni Clarity ni banner en el panel aunque el visitante haya aceptado cookies en la landing', async ({ page, backend, terceros }) => {
    await page.goto(LANDING);
    await decidirCookies(page, 'Aceptar');
    await expect.poll(() => terceros.solicitudes.meta.length).toBeGreaterThan(0);
    const antes = { meta: terceros.solicitudes.meta.length, clarity: terceros.solicitudes.clarity.length };
    await entrarAlPanel(page, USUARIOS.reclutadorA);
    await page.goto(`/panel/agenda/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Agenda' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Tu privacidad' })).toHaveCount(0);
    expect(terceros.solicitudes.meta.length).toBe(antes.meta);
    expect(terceros.solicitudes.clarity.length).toBe(antes.clarity);
    // La landing puede vaciar su cola por sendBeacon al salir (pagehide); lo que importa es que nada venga del panel.
    expect(backend.ingesta.filter((e) => String(e.pagina).startsWith('/panel')), 'sin eventos del panel').toEqual([]);
    expect(await page.evaluate(() => typeof (window as unknown as { fbq?: unknown }).fbq)).toBe('undefined');
  });

  test('E2E-11: aislamiento por rol — reclutador de A no ve B; B no ve A; cliente solo lectura; admin ve todo', async ({ page, backend }) => {
    const citaA = backend.sembrarCita(IDS.vacanteA, '2026-11-18T17:00:00.000Z', 'confirmada', 'Ana Torres');
    const citaB = backend.citas.find((c) => c.vacante_id === IDS.vacanteB)!;

    await entrarAlPanel(page, USUARIOS.reclutadorA);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr').first()).toContainText('Agente Smart');
    await expect(page.getByText('Operador Logístico')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Alta', exact: true })).toHaveCount(0);
    expect(await axeGraves(page)).toEqual([]);

    await page.goto('/panel/agenda/?fecha=2026-11-18');
    await expect(page.getByRole('table')).toContainText('Ana');
    await expect(page.getByRole('table')).not.toContainText('Bruno');
    expect(await axeGraves(page)).toEqual([]);
    await page.goto(`/panel/citas/?id=${citaB.id}`);
    await expect(page.getByText('La cita no existe o no tienes acceso.')).toBeVisible();
    await page.goto(`/panel/vacante/?id=${IDS.vacanteB}`);
    await expect(page.getByText('La vacante no existe o no tienes acceso.')).toBeVisible();
    await page.goto('/panel/admin/');
    await expect(page.getByText(/solo.*administra|no tienes permiso|Solo un administrador/i).first()).toBeVisible();
    // Aunque fuerce la llamada, el servidor (RPC con RLS) no le deja tocar B.
    const forzado = await page.evaluate(async ([cita, token]) => (await fetch('https://e2e.supabase.co/rest/v1/rpc/registrar_asistencia', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ p_cita: cita, p_asistio: true, p_evaluacion: null }) })).status, [citaB.id, jwtDe(USUARIOS.reclutadorA)] as const);
    expect(forzado).toBe(400);
    expect(backend.cita(citaB.id)?.estado).toBe('confirmada');

    // Reclutador de B: el espejo.
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await entrarAlPanel(page, USUARIOS.reclutadorB);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr').first()).toContainText('Operador Logístico');
    await page.goto(`/panel/citas/?id=${citaA.id}`);
    await expect(page.getByText('La cita no existe o no tienes acceso.')).toBeVisible();

    // Cliente de A: ve su vacante en solo lectura.
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await entrarAlPanel(page, USUARIOS.clienteA);
    await expect(page.getByText('Cliente (solo lectura)').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Ver reglas/ })).toHaveCount(1);
    await page.goto(`/panel/citas/?id=${citaA.id}`);
    await expect(page.getByText('Tu rol es de solo lectura para esta vacante.')).toBeVisible();
    await page.goto(`/panel/vacante/?id=${IDS.vacanteA}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Reglas de la vacante' })).toBeVisible();
    await expect(page.getByText(/versión vigente 1 · solo lectura/)).toBeVisible();
    await expect(page.getByLabel('Cupo diario')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Guardar nueva versión' })).toBeDisabled();
    expect(backend.llamadas('panel-reglas')).toHaveLength(0);

    // Admin: ambas vacantes y el alta.
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await entrarAlPanel(page, USUARIOS.admin);
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Alta', exact: true })).toBeVisible();
  });

  test('E2E-08: admin cambia las reglas (cupo 10→5, sin tarde) → la landing muestra los nuevos slots sin rebuild', async ({ page, backend }) => {
    // Antes: la landing ofrece la tarde.
    await page.goto(LANDING);
    await decidirCookies(page, 'Rechazar');
    await llenarDatos(page, { telefono: '8100000001' });
    await page.getByRole('group', { name: /Día disponible/ }).getByRole('button').nth(1).click();
    await expect(horasLanding(page).filter({ hasText: '3:00 pm' })).toHaveCount(1);
    const slotsAntes = await horasLanding(page).count();

    await entrarAlPanel(page, USUARIOS.admin);
    await page.goto(`/panel/vacante/?id=${IDS.vacanteA}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Reglas de la vacante' })).toBeVisible();
    await expect(page.getByText('versión vigente 1')).toBeVisible();
    const previa = page.getByRole('region', { name: 'Vista previa de horarios' });
    await expect(previa.getByText('15:00').first()).toBeVisible();
    await page.getByLabel('Cupo diario').fill('5');
    await page.getByLabel('Horarios de inicio (rangos)').fill('09:30-13:00');
    await expect(previa.getByText('15:00')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Cambios pendientes' }).getByText(/agenda\.cupo_diario: 10 → 5/)).toBeVisible();
    expect(await axeGraves(page)).toEqual([]);
    await page.getByRole('button', { name: 'Guardar nueva versión' }).click();
    await expect(page.getByText(/Guardado como versión 2/)).toBeVisible();
    const guardado = backend.llamadas('panel-reglas')[0]!;
    expect(guardado.headers['authorization']).toBe(`Bearer ${jwtDe(USUARIOS.admin)}`);
    expect(guardado.cuerpo).toMatchObject({ operacion: 'guardar_reglas', datos: { vacante_id: IDS.vacanteA, version_base: 1, reglas: { agenda: { cupo_diario: 5, ventanas_inicio: [{ desde: '09:30', hasta: '13:00' }] } } } });

    // Después: misma landing estática (sin rebuild), slots nuevos desde citas-api (reglas v2).
    const dia = backend.slotsLibres(IDS.vacanteA).find((s) => s.fecha === '2026-11-19')!; // jueves
    for (const h of ['15:30', '16:00', '16:30', '17:00', '17:30']) backend.sembrarCita(IDS.vacanteA, dia.inicio.replace('15:30', h)); // 5 citas = cupo nuevo
    // La pestaña recupera el avance (paso de horario) y vuelve a pedir los horarios a citas-api: no usa los viejos.
    await page.goto(LANDING);
    await expect(page.getByRole('heading', { name: /Selecciona día y hora/ })).toBeVisible();
    await page.getByRole('group', { name: /Día disponible/ }).getByRole('button').nth(1).click();
    await expect(horasLanding(page).first()).toBeVisible();
    await expect(horasLanding(page).filter({ hasText: /^\s*[3-5]:\d\d pm/ })).toHaveCount(0);
    expect(await horasLanding(page).count()).toBeLessThan(slotsAntes);
    const respuesta = await page.evaluate(async () => (await fetch('https://e2e.supabase.co/functions/v1/citas-api?vacante=agente-smart')).json());
    expect(respuesta.reglas_version).toBe(2);
    expect(respuesta.slots.some((s: { fecha: string }) => s.fecha === '2026-11-19'), 'el jueves llegó al cupo nuevo de 5').toBe(false);
    await expect(page.getByRole('group', { name: /Día disponible/ }).getByRole('button', { name: /Jue 19/ })).toHaveCount(0);
  });

  test('validación en vivo: un cupo inválido se marca y no se puede guardar', async ({ page, backend }) => {
    await entrarAlPanel(page, USUARIOS.reclutadorA);
    await page.goto(`/panel/vacante/?id=${IDS.vacanteA}`);
    await page.getByLabel('Cupo diario').fill('0');
    await expect(page.getByLabel('Cupo diario')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Corrige las reglas para ver la vista previa.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar nueva versión' })).toBeDisabled();
    expect(backend.llamadas('panel-reglas')).toHaveLength(0);
  });

  test('E2E-09: el reclutador abre el link del evento de Zoho → asistencia → CAPI offline y agradecimiento', async ({ page, backend, proveedores }) => {
    const folio = await agendarComoCandidato(page, proveedores, { telefono: '8112223344', nombre: 'Luis Pérez' });
    await backend.procesarColas();
    const ev = proveedores.llamadas('zoho').find((l) => l.metodo === 'POST')!.cuerpo as { eventdata: { description: string } };
    const link = /https?:\/\/\S+\/panel\/citas\/\?id=[0-9a-f-]{36}/.exec(ev.eventdata.description)![0];

    await entrarAlPanel(page, USUARIOS.reclutadorA);
    await page.goto(rutaDe(link));
    await expect(page.getByText(folio)).toBeVisible();
    await expect(page.getByText('Luis', { exact: true })).toBeVisible();
    await page.getByLabel('Sí asistió').check();
    await page.getByLabel('Calificación').selectOption('4');
    await page.getByLabel('Recomendación').selectOption('avanzar');
    expect(await axeGraves(page)).toEqual([]);
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.getByText(/Asistencia registrada/)).toBeVisible();
    const citaId = new URL(link).searchParams.get('id')!;
    expect(backend.rpcs.find((r) => r.nombre === 'registrar_asistencia')).toMatchObject({ cuerpo: { p_cita: citaId, p_asistio: true, p_evaluacion: { calificacion: 4, recomendacion: 'avanzar' } }, usuario: USUARIOS.reclutadorA.email });

    await backend.procesarColas();
    const capi = proveedores.llamadas('meta').flatMap((l) => (l.cuerpo as { data: Array<Record<string, unknown>> }).data);
    expect(capi.find((e) => e.event_name === 'CompleteRegistration')).toMatchObject({ action_source: 'system_generated', custom_data: { vacancy_id: IDS.vacanteA, client_id: IDS.clienteA } });
    const gracias = backend.mensajes.find((m) => m.tipo === 'agradecimiento');
    expect(gracias?.estado).toBe('enviado');
    expect(proveedores.llamadas('evolution').some((l) => /Gracias por asistir/.test(String((l.cuerpo as { text?: string }).text)))).toBe(true);
  });

  test('contratación: quien asistió se marca como contratado (dashboard.registrar_contratacion)', async ({ page, backend }) => {
    const cita = backend.sembrarCita(IDS.vacanteA, '2026-11-18T16:00:00.000Z', 'asistio', 'Ana Torres');
    await entrarAlPanel(page, USUARIOS.reclutadorA);
    await page.goto(`/panel/citas/?id=${cita.id}`);
    await expect(page.getByRole('heading', { name: 'Contratación' })).toBeVisible();
    expect(await axeGraves(page)).toEqual([]);
    await page.getByRole('button', { name: 'Marcar como contratado' }).click();
    await expect(page.getByText('Candidato marcado como contratado.')).toBeVisible();
    expect(backend.rpcs.find((r) => r.nombre === 'registrar_contratacion')?.cuerpo).toEqual({ p_cita: cita.id, p_entregado: false });
  });

  test('dashboard y agenda cargan con sesión; axe sin violaciones graves', async ({ page }) => {
    await entrarAlPanel(page, USUARIOS.admin);
    for (const [ruta, h1] of [['/panel/dashboard/', 'Dashboard'], ['/panel/agenda/', 'Agenda'], ['/panel/admin/', /Alta/]] as const) {
      await page.goto(ruta);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Cargando…' })).toHaveCount(0);
      expect(await axeGraves(page), ruta).toEqual([]);
    }
  });
});

test.describe('/panel/acceso/ (invitación y recuperación de Supabase Auth)', () => {
  const hash = (tipo: 'invite' | 'recovery') => `#access_token=${jwtDe(USUARIOS.reclutadorA)}&expires_at=4102444800&expires_in=3600&refresh_token=r1&token_type=bearer&type=${tipo}`;

  test('invitación: el token sale de la URL, valida la contraseña y la guarda; luego entra con ella', async ({ page, backend, terceros }) => {
    await page.goto(`/panel/acceso/${hash('invite')}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Crea tu contraseña' })).toBeVisible();
    await expect(page.getByText(USUARIOS.reclutadorA.email)).toBeVisible();
    expect(page.url(), 'el token no se queda en la URL').not.toContain('access_token');
    expect(await axeGraves(page)).toEqual([]);

    await page.getByLabel('Contraseña nueva').fill('corta');
    await page.getByLabel('Repite la contraseña').fill('otra');
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByText('Usa al menos 12 caracteres.')).toBeVisible();
    await expect(page.getByText('Las contraseñas no coinciden.')).toBeVisible();
    await expect(page.getByLabel('Contraseña nueva')).toHaveAttribute('aria-invalid', 'true');
    expect(await axeGraves(page)).toEqual([]);

    const nueva = 'Mi-Clave-Del-Panel-2026';
    await page.getByLabel('Contraseña nueva').fill(nueva);
    await page.getByLabel('Repite la contraseña').fill(nueva);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Contraseña guardada' })).toBeVisible();
    expect(backend.contrasenas.get(USUARIOS.reclutadorA.email)).toBe(nueva);
    await page.getByRole('link', { name: 'Ir al panel' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Vacantes' })).toBeVisible();
    expect(terceros.solicitudes.meta).toEqual([]);
    expect(terceros.violacionesCsp).toEqual([]);
  });

  test('recuperación: la contraseña igual a la anterior se rechaza con mensaje claro', async ({ page }) => {
    await page.goto(`/panel/acceso/${hash('recovery')}`);
    await expect(page.getByText(/Elige una contraseña nueva/)).toBeVisible();
    await page.getByLabel('Contraseña nueva').fill(PASSWORD_E2E);
    await page.getByLabel('Repite la contraseña').fill(PASSWORD_E2E);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByText('La contraseña nueva debe ser distinta de la anterior.')).toBeVisible();
  });

  test('enlace vencido → mensaje y solicitud de un enlace nuevo (respuesta neutra)', async ({ page, backend }) => {
    await page.goto('/panel/acceso/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await expect(page.getByRole('heading', { level: 1, name: 'Recupera tu acceso' })).toBeVisible();
    await expect(page.getByText(/El enlace venció o ya se usó/)).toBeVisible();
    expect(page.url()).not.toContain('error');
    expect(await axeGraves(page)).toEqual([]);
    await page.getByLabel('Correo').fill('quien-sea@e2e.test');
    await page.getByRole('button', { name: 'Enviar enlace' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Revisa tu correo' })).toBeVisible();
    expect(backend.recuperaciones).toEqual([{ email: 'quien-sea@e2e.test', redirect_to: expect.stringMatching(/\/panel\/acceso\/$/) }]);
  });

  test('desde el login se llega a recuperar el acceso', async ({ page }) => {
    await page.goto('/panel/');
    await page.getByRole('link', { name: /Olvidaste tu contraseña/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Recupera tu acceso' })).toBeVisible();
  });
});
