import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@shared/crypto.ts';
import { construirEventoGa4, construirEventoMeta, normalizarEmail, normalizarNombre, normalizarTelefono } from './capi.ts';

const base = {
  eventId: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e',
  nombreMeta: 'Lead',
  actionSource: 'website' as const,
  ocurridoEn: new Date('2026-11-13T18:00:00Z'),
  urlOrigen: 'https://capitalhumano369.com/vacantes/agente-smart/',
  customData: { vacancy_id: 'v1', client_id: 'c1', content_category: 'ventas' },
};

describe('normalización (NFR-SEG-04)', () => {
  it('teléfono MX a 52 + 10 dígitos; otros a solo dígitos', () => {
    expect(normalizarTelefono('+52 1 (81) 1234-5678')).toBe('528112345678');
    expect(normalizarTelefono('8112345678')).toBe('528112345678');
    expect(normalizarTelefono('+1 415 555 0101')).toBe('14155550101');
    expect(normalizarTelefono('12')).toBeNull();
  });
  it('correo en minúsculas y sin espacios; nombre sin acentos ni signos', () => {
    expect(normalizarEmail('  Ana.Lopez@Mail.COM ')).toBe('ana.lopez@mail.com');
    expect(normalizarEmail('no-es-correo')).toBeNull();
    expect(normalizarNombre(' José-María ')).toBe('josemaria');
    expect(normalizarNombre('  ')).toBeNull();
  });
});

describe('T5 · payload hacia CAPI', () => {
  it('ph y em con SHA-256, sin PII en claro, custom_data con vacancy_id y client_id', async () => {
    const ev = await construirEventoMeta({
      ...base,
      contacto: { telefono: '81 1234 5678', email: 'Ana@Mail.com', nombrePila: 'Ana' },
      visitante: { visitorId: '01934f6e-0000-7000-8000-000000000001', ip: '189.203.1.2', userAgent: 'UA/1.0', fbc: 'fb.1.1700000000000.IwAR', fbp: 'fb.1.1700000000000.123' },
    });
    expect(ev.user_data.ph).toEqual([await sha256Hex('528112345678')]);
    expect(ev.user_data.em).toEqual([await sha256Hex('ana@mail.com')]);
    expect(ev.user_data.fn).toEqual([await sha256Hex('ana')]);
    expect(ev.user_data.external_id).toEqual([await sha256Hex('01934f6e-0000-7000-8000-000000000001')]);
    expect(ev.user_data.client_ip_address).toBe('189.203.1.2');
    expect(ev.user_data.fbc).toBe('fb.1.1700000000000.IwAR');
    expect(ev.custom_data).toEqual({ vacancy_id: 'v1', client_id: 'c1', content_category: 'ventas' });
    expect(ev.event_time).toBe(Math.floor(base.ocurridoEn.getTime() / 1000));
    expect(ev.event_id).toBe(base.eventId);
    expect(ev.event_source_url).toBe(base.urlOrigen);
    const texto = JSON.stringify(ev);
    expect(texto).not.toMatch(/8112345678|ana@mail|"Ana"/i);
  });

  it('sin contacto ni visitante solo lleva lo mínimo; system_generated sin url', async () => {
    const ev = await construirEventoMeta({ ...base, actionSource: 'system_generated', nombreMeta: 'CompleteRegistration', urlOrigen: null });
    expect(ev.user_data).toEqual({});
    expect(ev.action_source).toBe('system_generated');
    expect(ev).not.toHaveProperty('event_source_url');
  });

  it('descarta IP inválida y correo/teléfono inválidos', async () => {
    const ev = await construirEventoMeta({ ...base, contacto: { telefono: '1', email: 'x', nombrePila: '' }, visitante: { visitorId: null, ip: 'basura', userAgent: null, fbc: null, fbp: null } });
    expect(ev.user_data).toEqual({});
  });
});

describe('payload GA4 (Measurement Protocol)', () => {
  it('client_id = visitor_id, sin PII, con custom_data como params', () => {
    const p = construirEventoGa4({ nombre: 'generate_lead', clientId: 'vid-1', eventId: base.eventId, ocurridoEn: base.ocurridoEn, customData: base.customData });
    expect(p).toEqual({
      client_id: 'vid-1',
      timestamp_micros: base.ocurridoEn.getTime() * 1000,
      events: [{ name: 'generate_lead', params: { event_id: base.eventId, vacancy_id: 'v1', client_id: 'c1', content_category: 'ventas', engagement_time_msec: 1 } }],
    });
  });
});
