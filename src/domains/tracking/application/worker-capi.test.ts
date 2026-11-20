/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON de proveedores en aserciones */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@shared/crypto.ts';
import { procesarColaCapi } from './worker-capi.ts';
import { colaFalsa, contactosFalsos, ga4Falso, logNulo, metaFalsa, repoFalso } from '../pruebas/fakes.ts';

const EID = '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e';
const VID = '01934f6e-0000-7000-8000-000000000001';
const LEAD = '01934f6e-aaaa-7000-8000-000000000001';
const VAC = '11111111-1111-4111-8111-111111111111';
const CLI = '22222222-2222-4222-8222-222222222222';

async function escenario(nombre = 'LeadCreado', extra: Record<string, unknown> = {}) {
  const r = repoFalso();
  await r.repo.registrarEvento({ event_id: EID, nombre, fuente: 'servidor', consentimiento: true, visitor_id: VID, lead_id: LEAD, vacante_ref: VAC, cliente_ref: CLI, content_category: 'ventas', origen: 'meta_pagado', ...extra }, ['meta', 'ga4']);
  r.contextos.set(VID, { ip: '189.203.1.2', userAgent: 'UA/1', fbc: 'fb.1.1700000000000.IwAR1', fbp: 'fb.1.1700000000000.42', pagina: '/vacantes/agente-smart/', origen: 'meta_pagado', utmSource: 'facebook', utmMedium: 'paid', utmCampaign: 'nov' });
  return r;
}

const deps = (over: Record<string, unknown>) => ({
  contactos: contactosFalsos({ [LEAD]: { telefonoE164: '+528112345678', email: 'ana@x.com', nombrePila: 'Ana' } }),
  config: { sitioUrl: 'https://capitalhumano369.com' },
  log: logNulo,
  ...over,
});

describe('worker de la cola tracking-capi', () => {
  it('T5 · Lead a CAPI: ph hasheado, fbc/fbp/IP/UA del visitante, custom_data con vacancy_id y client_id', async () => {
    const r = await escenario();
    const m = metaFalsa();
    const g = ga4Falso();
    const c = colaFalsa([{ id: '1', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: EID } }, { id: '2', intentos: 0, maxIntentos: 5, payload: { destino: 'ga4', event_id: EID } }]);
    const res = await procesarColaCapi(deps({ repo: r.repo, cola: c.cola, meta: m.meta, ga4: g.ga4 }) as never);
    expect(res).toEqual({ enviados: 2, reintentos: 0, deadLetters: 0, omitidos: 0 });
    const req = m.enviados[0] as { data: Array<Record<string, any>> };
    expect(req.data).toHaveLength(1);
    const ev = req.data[0]!;
    expect(ev).toMatchObject({ event_name: 'Lead', event_id: EID, action_source: 'website', event_source_url: 'https://capitalhumano369.com/vacantes/agente-smart/' });
    expect(ev.user_data.ph).toEqual([await sha256Hex('528112345678')]);
    expect(ev.user_data).toMatchObject({ client_ip_address: '189.203.1.2', client_user_agent: 'UA/1', fbc: 'fb.1.1700000000000.IwAR1', fbp: 'fb.1.1700000000000.42' });
    expect(ev.custom_data).toEqual({ vacancy_id: VAC, client_id: CLI, content_category: 'ventas' });
    expect(JSON.stringify(req)).not.toMatch(/8112345678|ana@x|"Ana"/);
    expect(g.enviados[0]).toMatchObject({ client_id: VID, events: [{ name: 'generate_lead' }] });
    expect(c.estado.get('1')).toBe('completado');
  });

  it('T6 · asistencia registrada → evento offline system_generated sin URL', async () => {
    const r = await escenario('AsistenciaRegistrada', { propiedades: { asistio: true } });
    const m = metaFalsa();
    const c = colaFalsa([{ id: '1', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: EID } }]);
    await procesarColaCapi(deps({ repo: r.repo, cola: c.cola, meta: m.meta, ga4: ga4Falso().ga4 }) as never);
    const ev = (m.enviados[0] as { data: Array<Record<string, unknown>> }).data[0]!;
    expect(ev).toMatchObject({ event_name: 'CompleteRegistration', action_source: 'system_generated' });
    expect(ev).not.toHaveProperty('event_source_url');
  });

  it('T7 · CAPI 500 → reintento con backoff y el mismo evento; luego se completa sin pérdida', async () => {
    const r = await escenario();
    const m = metaFalsa([500, 'ok']);
    const c = colaFalsa([{ id: '1', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: EID } }]);
    const d = deps({ repo: r.repo, cola: c.cola, meta: m.meta, ga4: ga4Falso().ga4 }) as never;
    expect(await procesarColaCapi(d)).toMatchObject({ reintentos: 1, enviados: 0 });
    expect(c.estado.get('1')).toBe('reintento');
    expect(await procesarColaCapi(d)).toMatchObject({ enviados: 1 });
    expect(c.estado.get('1')).toBe('completado');
    expect(m.enviados[0]).toEqual(m.enviados[1]);
    expect(c.backoffs).toEqual([30]);
  });

  it('agotados los intentos → dead letter; backoff exponencial con tope', async () => {
    const r = await escenario();
    const m = metaFalsa([500]);
    const c = colaFalsa([{ id: '1', intentos: 0, maxIntentos: 3, payload: { destino: 'meta', event_id: EID } }]);
    const d = deps({ repo: r.repo, cola: c.cola, meta: m.meta, ga4: ga4Falso().ga4 }) as never;
    await procesarColaCapi(d);
    await procesarColaCapi(d);
    expect(await procesarColaCapi(d)).toMatchObject({ deadLetters: 1 });
    expect(c.backoffs).toEqual([30, 60, 120]);
  });

  it('omite (completa sin enviar) eventos borrados, leads suprimidos, GA4 sin visitante y mapeos nulos', async () => {
    const r = await escenario();
    await r.repo.registrarEvento({ event_id: 'e-sin-visitor', nombre: 'LeadCreado', fuente: 'servidor', consentimiento: false, lead_id: LEAD, origen: 'directo' }, []);
    await r.repo.registrarEvento({ event_id: 'e-whatsapp', nombre: 'WhatsAppVerificado', fuente: 'servidor', consentimiento: true, visitor_id: VID, origen: 'directo' }, []);
    const m = metaFalsa();
    const c = colaFalsa([
      { id: '1', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: 'no-existe' } },
      { id: '2', intentos: 0, maxIntentos: 5, payload: { destino: 'ga4', event_id: 'e-sin-visitor' } },
      { id: '3', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: 'e-whatsapp' } },
      { id: '4', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: EID } },
    ]);
    const res = await procesarColaCapi(deps({ repo: r.repo, cola: c.cola, meta: m.meta, ga4: ga4Falso().ga4, contactos: contactosFalsos({}) }) as never);
    expect(res).toEqual({ enviados: 0, reintentos: 0, deadLetters: 0, omitidos: 4 });
    expect(m.enviados).toEqual([]);
    expect([...c.estado.values()]).toEqual(['completado', 'completado', 'completado', 'completado']);
  });

  it('un error inesperado (excepción) también se reintenta', async () => {
    const r = await escenario();
    const c = colaFalsa([{ id: '1', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: EID } }]);
    const meta = { enviar: async () => { throw new Error('boom'); } };
    expect(await procesarColaCapi(deps({ repo: r.repo, cola: c.cola, meta, ga4: ga4Falso().ga4 }) as never)).toMatchObject({ reintentos: 1 });
  });

  it('evento de navegador: usa su propia IP/UA, sin contacto, con test_event_code; error de GA4 se reintenta', async () => {
    const r = repoFalso();
    await r.repo.registrarEvento({ event_id: EID, nombre: 'PageView', fuente: 'navegador', consentimiento: true, visitor_id: VID, cliente_ref: CLI, origen: 'directo', ip: '10.0.0.1', user_agent: 'UA/2', pagina: '/' }, ['meta', 'ga4']);
    const m = metaFalsa();
    const ga4 = { enviar: async () => ({ ok: false as const, error: { reintentable: true, status: 503, mensaje: 'HTTP 503' } }) };
    const c = colaFalsa([{ id: '1', intentos: 0, maxIntentos: 5, payload: { destino: 'meta', event_id: EID } }, { id: '2', intentos: 0, maxIntentos: 5, payload: { destino: 'ga4', event_id: EID } }]);
    const res = await procesarColaCapi({ ...deps({ repo: r.repo, cola: c.cola, meta: m.meta, ga4 }), config: { sitioUrl: 'https://x.mx/', testEventCode: 'TEST1' } } as never);
    expect(res).toMatchObject({ enviados: 1, reintentos: 1 });
    const req = m.enviados[0] as { test_event_code: string; data: Array<Record<string, any>> };
    expect(req.test_event_code).toBe('TEST1');
    expect(req.data[0]!.user_data).toMatchObject({ client_ip_address: '10.0.0.1', client_user_agent: 'UA/2' });
    expect(req.data[0]!.user_data).not.toHaveProperty('ph');
    expect(req.data[0]!.event_source_url).toBe('https://x.mx/');
  });
});
