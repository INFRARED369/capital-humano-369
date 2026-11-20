/**
 * /cita/?t= y /cita/gestionar/?t= (CIT-11, C15, E2E-10) con tokens FIRMADOS reales (firmarLinkGestion) contra el
 * backend simulado. E2E-10 sale del link que el sistema envió por WhatsApp (mock de Evolution).
 */
import {
  IDS, agendarComoCandidato, axeGraves, expect, rutaDe, rutaExportada, test,
} from './fixtures';

test.beforeEach(() => {
  test.skip(!rutaExportada('/cita/') || !rutaExportada('/cita/gestionar/'), '/cita/ aún no está en out/');
});

const INICIO = '2026-11-19T16:00:00.000Z'; // jueves 10:00 CDMX

test('sin token → mensaje claro; 200, axe y sin violaciones de CSP', async ({ page, terceros }) => {
  const res = await page.goto('/cita/gestionar/');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Falta el enlace de tu cita' })).toBeVisible();
  expect(await axeGraves(page)).toEqual([]);
  expect(terceros.violacionesCsp).toEqual([]);
});

test('C15: link vencido → 401 TOKEN_VENCIDO; link alterado → 401 TOKEN_INVALIDO', async ({ page, backend }) => {
  const cita = backend.sembrarCita(IDS.vacanteA, INICIO);
  const vencido = await backend.linkGestion(cita.id, 'cancelar', new Date(backend.ahora().getTime() - 60_000).toISOString());
  await page.goto(`/cita/gestionar/?t=${vencido}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Este enlace venció' })).toBeVisible();
  const bueno = await backend.linkGestion(cita.id, 'cancelar');
  const alterado = `${bueno.slice(0, -1)}${bueno.endsWith('0') ? '1' : '0'}`;
  await page.goto(`/cita/?t=${alterado}`);
  await expect(page.getByRole('heading', { level: 1, name: 'El enlace no es válido' })).toBeVisible();
  expect(await axeGraves(page)).toEqual([]);
  expect(backend.cita(cita.id)?.estado).toBe('confirmada');
});

test('E2E-10: el candidato cancela desde el link de WhatsApp → slot libre, evento de Zoho borrado y recordatorios cancelados', async ({ page, backend, proveedores, terceros }) => {
  await agendarComoCandidato(page, proveedores, { telefono: '8119998877', cookies: 'Aceptar', dia: 2 });
  await backend.procesarColas();
  const cita = backend.citas.find((c) => c.estado === 'confirmada' && c.vacante_id === IDS.vacanteA)!;
  expect(cita.zoho_event_uid).toBeTruthy();
  expect(backend.slotsLibres(IDS.vacanteA).some((s) => s.inicio === cita.inicio)).toBe(false);
  const confirmacion = proveedores.llamadas('evolution').map((l) => String((l.cuerpo as { text?: string }).text)).find((t) => t.includes('Cancelar:'))!;
  const link = /Cancelar: (\S+)/.exec(confirmacion)![1]!;
  const tercerosAntes = { meta: terceros.solicitudes.meta.length, clarity: terceros.solicitudes.clarity.length };

  await page.goto(rutaDe(link)); // /cita/?t=<token> (formato de Comunicación)
  await expect(page.getByRole('heading', { level: 1, name: 'Cancelar tu cita' })).toBeVisible();
  expect(page.url(), 'el token sale de la URL').not.toContain('t=');
  expect(await axeGraves(page)).toEqual([]);
  await page.getByRole('button', { name: 'Sí, cancelar mi cita' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tu cita fue cancelada' })).toBeVisible();
  expect(backend.llamadas('gestionar-cita').map((l) => (l.cuerpo as { operacion: string }).operacion)).toEqual(['consultar', 'ejecutar']);
  // Aunque aceptó cookies en la landing, /cita/ no carga Pixel ni Clarity (el token no llega a terceros).
  expect(terceros.solicitudes.meta.length).toBe(tercerosAntes.meta);
  expect(terceros.solicitudes.clarity.length).toBe(tercerosAntes.clarity);
  expect(backend.ingesta.filter((e) => String(e.pagina).startsWith('/cita')), 'sin eventos de /cita/').toEqual([]);

  await backend.procesarColas();
  expect(backend.cita(cita.id)?.estado).toBe('cancelada');
  expect(backend.slotsLibres(IDS.vacanteA).some((s) => s.inicio === cita.inicio), 'slot libre').toBe(true);
  const borrado = proveedores.llamadas('zoho').find((l) => l.metodo === 'DELETE');
  expect(borrado?.ruta).toMatch(new RegExp(`/events/${cita.zoho_event_uid ?? 'zev-'}`));
  expect(backend.cita(cita.id)?.zoho_event_uid).toBeNull();
  expect(backend.mensajes.filter((m) => m.cita_id === cita.id && m.tipo.startsWith('recordatorio')).map((m) => m.estado)).toEqual(['cancelado', 'cancelado']);
  // Un segundo uso del mismo link ya no aplica.
  await page.goto(rutaDe(link));
  await expect(page.getByRole('heading', { level: 1, name: 'Tu cita ya no se puede modificar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sí, cancelar mi cita' })).toHaveCount(0);
});

test('reprogramar desde /cita/gestionar/: elige un horario de los slots vigentes y confirma; axe en la lista', async ({ page, backend }) => {
  const cita = backend.sembrarCita(IDS.vacanteA, INICIO);
  const token = await backend.linkGestion(cita.id, 'reprogramar');
  await page.goto(`/cita/gestionar/?t=${token}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Reprogramar tu cita' })).toBeVisible();
  expect(await axeGraves(page)).toEqual([]);
  const destino = backend.slotsLibres(IDS.vacanteA).find((s) => s.fecha === '2026-11-20' && s.horaLocal === '09:30')!;
  await page.locator(`input[value="${destino.inicio}"]`).check();
  await page.getByRole('button', { name: 'Confirmar nuevo horario' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tu cita fue reprogramada' })).toBeVisible();
  expect(backend.llamadas('gestionar-cita').at(-1)?.cuerpo).toEqual({ token, operacion: 'ejecutar', nuevo_inicio: destino.inicio });
  expect(backend.cita(cita.id)?.estado).toBe('reprogramada');
  expect(backend.citas.find((c) => c.inicio === destino.inicio && c.estado === 'confirmada')).toBeTruthy();
});

test('el horario se ocupa mientras elige → 409 y mensaje para elegir otro', async ({ page, backend }) => {
  const cita = backend.sembrarCita(IDS.vacanteA, INICIO);
  await page.goto(`/cita/gestionar/?t=${await backend.linkGestion(cita.id, 'reprogramar')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Reprogramar tu cita' })).toBeVisible();
  const destino = backend.slotsLibres(IDS.vacanteA).find((s) => s.inicio !== INICIO)!;
  await page.locator(`input[value="${destino.inicio}"]`).check();
  backend.sembrarCita(IDS.vacanteA, destino.inicio); // otro candidato lo toma
  await page.getByRole('button', { name: 'Confirmar nuevo horario' }).click();
  await expect(page.getByText('Elige otro horario de la lista.')).toBeVisible();
  expect(backend.cita(cita.id)?.estado).toBe('confirmada');
});
