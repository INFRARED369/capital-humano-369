import { describe, expect, it } from 'vitest';
import { procesarOutbox } from './consumidor-outbox.ts';
import { logNulo, outboxFalso, repoFalso } from '../pruebas/fakes.ts';

const VID = '01934f6e-0000-7000-8000-000000000001';
const LEAD = '01934f6e-aaaa-7000-8000-000000000001';
const VAC = '11111111-1111-4111-8111-111111111111';
const CLI = '22222222-2222-4222-8222-222222222222';
const E_LEAD = '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e';

const leadCreado = (visitor: string | null = VID) => ({ id: '1', tipo: 'LeadCreado', payload: { lead_id: LEAD, vacante_id: VAC, cliente_id: CLI, folio: 'A1', event_id: E_LEAD, visitor_id: visitor, origen: 'meta_pagado' } });
const citaConfirmada = (eventId = '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d11') => ({ id: '3', tipo: 'CitaConfirmada', payload: { cita_id: 'c1', lead_id: LEAD, vacante_id: VAC, cliente_id: CLI, inicio: 'x', fin: 'y', folio: 'A1', nombre_pila: 'Ana', reglas_version: 1, event_id: eventId } });

function correr(eventos: Array<{ id: string; tipo: string; payload: Record<string, unknown> }>, capiSinCookies = false) {
  const r = repoFalso();
  r.contextos.set(VID, { ip: '1.2.3.4', userAgent: 'UA', fbc: null, fbp: null, pagina: '/', origen: 'meta_pagado', utmSource: 'facebook', utmMedium: 'paid', utmCampaign: 'nov' });
  const o = outboxFalso(eventos);
  const deps = { enTransaccion: <T>(fn: (u: never) => Promise<T>) => fn({ repo: r.repo, outbox: o.outbox } as never), politica: { capiSinCookies }, log: logNulo };
  return { r, o, deps, run: () => procesarOutbox(deps) };
}

describe('consumidor del outbox (consumidor "tracking")', () => {
  it('LeadCreado → vincula lead, registra el evento con el MISMO event_id del Pixel y encola Lead a Meta y GA4', async () => {
    const { r, o, run } = correr([leadCreado()]);
    expect(await run()).toEqual({ procesados: 1 });
    expect(r.leads.get(LEAD)).toMatchObject({ visitorId: VID, origen: 'meta_pagado' });
    expect(r.eventos.get(E_LEAD)).toMatchObject({ nombre: 'LeadCreado', fuente: 'servidor', lead_id: LEAD, visitor_id: VID, utm_campaign: 'nov', destinos: ['meta', 'ga4'] });
    expect(o.cursor).toBe(1);
  });

  it('T8 · Schedule solo con CitaConfirmada (después del OTP); WhatsAppVerificado no va a Meta', async () => {
    const { r, run } = correr([
      leadCreado(),
      { id: '2', tipo: 'WhatsAppVerificado', payload: { lead_id: LEAD, vacante_id: VAC, cliente_id: CLI, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d10' } },
      citaConfirmada(),
    ]);
    await run();
    expect(r.eventos.get('01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d10')!.destinos).toEqual(['ga4']);
    expect(r.eventos.get('01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d11')).toMatchObject({ nombre: 'CitaConfirmada', destinos: ['meta', 'ga4'], visitor_id: VID });
  });

  it('T6 · AsistenciaRegistrada(asistio) → evento offline; no asistió → sin envío', async () => {
    const { r, run } = correr([
      leadCreado(),
      { id: '4', tipo: 'AsistenciaRegistrada', payload: { cita_id: 'c1', lead_id: LEAD, vacante_id: VAC, cliente_id: CLI, asistio: true, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d12' } },
      { id: '5', tipo: 'AsistenciaRegistrada', payload: { cita_id: 'c2', lead_id: LEAD, vacante_id: VAC, cliente_id: CLI, asistio: false, event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d13' } },
    ]);
    await run();
    expect(r.eventos.get('01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d12')).toMatchObject({ propiedades: { asistio: true }, destinos: ['meta', 'ga4'] });
    expect(r.eventos.get('01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d13')!.destinos).toEqual(['ga4']);
  });

  it('TRK-09 · LeadContratado → Contratado offline UNA vez por cita: el de entrega (entregado_en) no reenvía', async () => {
    const contratado = (id: string, eventId: string, entregado: string | null) =>
      ({ id, tipo: 'LeadContratado', payload: { lead_id: LEAD, vacante_id: VAC, cliente_id: CLI, cita_id: '33333333-3333-4333-8333-333333333333', entregado_en: entregado, event_id: eventId } });
    const { r, o, run } = correr([
      leadCreado(),
      contratado('6', '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d14', null),
      contratado('7', '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d15', '2026-11-20T10:00:00.000Z'),
    ]);
    await run();
    const contr = [...r.eventos.values()].filter((e) => e.nombre === 'LeadContratado');
    expect(contr).toHaveLength(1);
    expect(contr[0]).toMatchObject({ fuente: 'servidor', lead_id: LEAD, visitor_id: VID, destinos: ['meta', 'ga4'] });
    expect(o.cursor).toBe(7);
  });

  it('TRK-09 · contratado y entregado en un solo paso (solo existe el evento con entregado_en) → se envía una vez', async () => {
    const { r, run } = correr([
      leadCreado(),
      { id: '8', tipo: 'LeadContratado', payload: { lead_id: LEAD, vacante_id: VAC, cliente_id: CLI, cita_id: null, entregado_en: '2026-11-20T10:00:00.000Z', event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d16' } },
    ]);
    await run();
    expect([...r.eventos.values()].filter((e) => e.nombre === 'LeadContratado')).toHaveLength(1);
  });

  it('lead sin consentimiento de cookies: se registra sin envíos (salvo política capiSinCookies, que solo habilita Meta)', async () => {
    const a = correr([leadCreado(null)]);
    await a.run();
    expect(a.r.eventos.get(E_LEAD)).toMatchObject({ consentimiento: false, visitor_id: null, destinos: [] });
    const b = correr([leadCreado(null)], true);
    await b.run();
    expect(b.r.eventos.get(E_LEAD)!.destinos).toEqual(['meta']);
  });

  it('si un evento de servidor reutiliza el event_id del Lead, se deriva uno determinista (no se pierde por dedupe)', async () => {
    const { r, run } = correr([leadCreado(), citaConfirmada(E_LEAD)]);
    await run();
    const cita = [...r.eventos.values()].find((e) => e.nombre === 'CitaConfirmada')!;
    expect(cita.event_id).not.toBe(E_LEAD);
    expect(cita.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('payload inválido se salta sin bloquear el cursor; sin eventos no avanza', async () => {
    const { r, o, run } = correr([{ id: '7', tipo: 'LeadCreado', payload: { lead_id: 'x' } }]);
    await run();
    expect(r.eventos.size).toBe(0);
    expect(o.cursor).toBe(7);
    const vacio = correr([]);
    expect(await vacio.run()).toEqual({ procesados: 0 });
  });
});
