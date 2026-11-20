/** Autoprueba de los fixtures: backend simulado (contratos), stubs de terceros y servidor de mocks de proveedores. */
import { IDS, USUARIOS, expect, jwtDe, test } from './fixtures';

// eslint-disable-next-line no-empty-pattern -- Playwright exige desestructurar fixtures
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'los mocks no dependen del dispositivo');
});

test('backend: citas-api responde con el contrato real (generarSlots de la plantilla) y registra llamadas', async ({ page, backend }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const slots = await (await fetch('https://e2e.supabase.co/functions/v1/citas-api?vacante=agente-smart')).json();
    const otp = await fetch('https://e2e.supabase.co/functions/v1/verificar-otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: '0192f0a0-0000-7000-8000-000000000001', codigo: '000000' }) });
    return { slots, otp: otp.status };
  });
  expect(r.slots).toMatchObject({ vacante_id: IDS.vacanteA, agenda_modo: 'sistema', zona_horaria: 'America/Mexico_City', reglas_version: 1 });
  expect(r.slots.slots[0]).toEqual({ inicio_utc: '2026-11-17T17:00:00.000Z', fin_utc: '2026-11-17T18:30:00.000Z', inicio_local: '2026-11-17T11:00:00-06:00', fecha: '2026-11-17', hora_local: '11:00', disponibles: 1 });
  expect(r.otp).toBe(404);
  expect(backend.llamadas('verificar-otp')[0]!.cuerpo).toEqual({ lead_id: '0192f0a0-0000-7000-8000-000000000001', codigo: '000000' });
  backend.responder('citas-api', () => ({ estado: 503, cuerpo: { error: 'caido' } }));
  expect(await page.evaluate(async () => (await fetch('https://e2e.supabase.co/functions/v1/citas-api?vacante=agente-smart')).status)).toBe(503);
});

test('backend: PostgREST aplica el RLS simulado por usuario (S1) y anon no ve nada (S2)', async ({ page }) => {
  await page.goto('/');
  const leer = (token: string | null) =>
    page.evaluate(async (t) => (await (await fetch('https://e2e.supabase.co/rest/v1/vacantes?select=id', { headers: t ? { authorization: `Bearer ${t}` } : {} })).json()) as Array<{ id: string }>, token);
  expect((await leer(jwtDe(USUARIOS.reclutadorA))).map((v) => v.id)).toEqual([IDS.vacanteA]);
  expect((await leer(jwtDe(USUARIOS.reclutadorB))).map((v) => v.id)).toEqual([IDS.vacanteB]);
  expect(await leer(jwtDe(USUARIOS.admin))).toHaveLength(2);
  expect(await leer(null)).toEqual([]);
});

test('terceros: scripts de Pixel/Clarity/Turnstile se stubean y se registran', async ({ page, terceros }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const cargar = (src: string) => new Promise((ok) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ok; document.head.append(s); });
    await cargar('https://connect.facebook.net/en_US/fbevents.js');
    await cargar('https://challenges.cloudflare.com/turnstile/v0/api.js');
  });
  expect(terceros.solicitudes.meta).toHaveLength(1);
  expect(await page.evaluate(() => typeof (window as unknown as { turnstile?: unknown }).turnstile)).toBe('object');
  expect(terceros.solicitudes.clarity).toEqual([]);
});

test('proveedores: Zoho/Evolution/CAPI registran llamadas y simulan caídas', async ({ proveedores }) => {
  proveedores.reiniciar();
  const post = (ruta: string, body: unknown) => fetch(`${proveedores.url}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const evo = await (await post('/evolution/chat/whatsappNumbers/inst', { numbers: ['528112345678', '528100000000'] })).json();
  expect(evo.map((x: { exists: boolean }) => x.exists)).toEqual([true, false]);
  expect((await (await post('/meta/v21.0/123/events', { data: [{}, {}] })).json()).events_received).toBe(2);
  proveedores.fallar('zoho', 1);
  expect((await post('/zoho/api/v1/calendars/c/events', {})).status).toBe(503);
  expect((await post('/zoho/api/v1/calendars/c/events', {})).status).toBe(200);
  expect(proveedores.llamadas('zoho')).toHaveLength(2);
  expect(proveedores.entorno.EVOLUTION_URL).toBe(`${proveedores.url}/evolution`);
});

test('CSP: un script inline sin hash se bloquea y el fixture lo registra como violación (securitypolicyviolation)', async ({ page, terceros }) => {
  await page.goto('/');
  // La página real no tiene violaciones: sus scripts inline van por hash (scripts/csp-hashes.mjs).
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');
  expect(terceros.violacionesCsp).toEqual([]);
  const ejecutado = await page.evaluate(async () => {
    const s = document.createElement('script');
    s.textContent = 'window.__inyectado = true';
    document.body.append(s);
    await new Promise((r) => setTimeout(r, 50));
    return (window as unknown as { __inyectado?: boolean }).__inyectado === true;
  });
  expect(ejecutado, 'la CSP no debe permitir scripts inline arbitrarios').toBe(false);
  await expect.poll(() => terceros.violacionesCsp.some((v) => /securitypolicyviolation script-src(-elem)? bloqueó inline/.test(v))).toBe(true);
  terceros.violacionesCsp.length = 0; // esperado: no debe fallar el teardown del fixture
});
