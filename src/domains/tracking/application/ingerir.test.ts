import { describe, expect, it } from 'vitest';
import { ingerirEvento } from './ingerir.ts';
import { repoFalso } from '../pruebas/fakes.ts';

const EID = '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e';
const VID = '01934f6e-0000-7000-8000-000000000001';
const geo = { ciudad: 'Monterrey', region: 'NLE', pais: 'MX' };
const conConsentimiento = {
  v: 1, event_id: EID, nombre: 'PageView', consentimiento: true, visitor_id: VID, pagina: '/vacantes/agente-smart/',
  referrer: 'https://www.google.com', atribucion: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'nov', fbclid: 'IwAR1', fbc: 'fb.1.1700000000000.IwAR1', fbp: 'fb.1.1700000000000.42' },
  custom_data: { vacancy_id: 'agente-smart', content_category: 'ventas' }, props: { cta: 'postular', nota: 'mi correo ana@x.com' },
};

describe('TRK-06 · caso de uso ingerirEvento', () => {
  it('registra con IP, UA, ciudad, origen clasificado y destinos según §8', async () => {
    const f = repoFalso();
    const r = await ingerirEvento({ repo: f.repo, hostPropio: 'capitalhumano369.com' }, { cuerpo: conConsentimiento, ip: '::ffff:189.203.1.2', userAgent: 'UA/1', geo });
    expect(r).toEqual({ ok: true, value: { registro: 'evento' } });
    const e = f.eventos.get(EID)!;
    expect(e).toMatchObject({
      nombre: 'PageView', fuente: 'navegador', consentimiento: true, visitor_id: VID, origen: 'meta_pagado', ip: '189.203.1.2', user_agent: 'UA/1',
      ciudad: 'Monterrey', pais: 'MX', vacante_ref: 'agente-smart', referrer_host: 'www.google.com', fbc: 'fb.1.1700000000000.IwAR1', utm_campaign: 'nov',
    });
    expect(e.destinos).toEqual(['meta', 'ga4']);
    expect(e.propiedades).toEqual({ cta: 'postular', nota: 'mi correo ***' });
  });

  it('T3 · un event_id repetido se reporta como duplicado', async () => {
    const f = repoFalso();
    await ingerirEvento({ repo: f.repo }, { cuerpo: conConsentimiento, ip: null, userAgent: null, geo: {} });
    const r = await ingerirEvento({ repo: f.repo }, { cuerpo: conConsentimiento, ip: null, userAgent: null, geo: {} });
    expect(r).toEqual({ ok: true, value: { registro: 'duplicado' } });
  });

  it('sin consentimiento solo cuenta (sin IP, UA ni visitor); usa la presencia de fbclid para el origen', async () => {
    const f = repoFalso();
    const cuerpo = { v: 1, event_id: EID, nombre: 'ClickCTA', consentimiento: false, atribucion: { tiene_fbclid: true }, custom_data: { vacancy_id: 'agente-smart' } };
    const r = await ingerirEvento({ repo: f.repo }, { cuerpo, ip: '1.2.3.4', userAgent: 'UA', geo });
    expect(r).toEqual({ ok: true, value: { registro: 'anonimo' } });
    expect(f.eventos.size).toBe(0);
    expect(f.anonimos).toEqual([{ nombre: 'ClickCTA', vacante_ref: 'agente-smart', cliente_ref: null, origen: 'organico_meta', utm_source: null, utm_campaign: null }]);
    expect(JSON.stringify(f.anonimos)).not.toMatch(/1\.2\.3\.4|UA/);
  });

  it('cuerpo inválido → INVALIDO; IP inválida se descarta; SectionView solo a GA4', async () => {
    const f = repoFalso();
    expect(await ingerirEvento({ repo: f.repo }, { cuerpo: { nombre: 'Schedule' }, ip: null, userAgent: null, geo: {} })).toEqual({ ok: false, error: 'INVALIDO' });
    await ingerirEvento({ repo: f.repo }, { cuerpo: { ...conConsentimiento, nombre: 'SectionView' }, ip: 'basura', userAgent: 'x'.repeat(900), geo: {} });
    const e = f.eventos.get(EID)!;
    expect(e.ip).toBeNull();
    expect(e.user_agent).toHaveLength(500);
    expect(e.destinos).toEqual(['ga4']);
  });
});
