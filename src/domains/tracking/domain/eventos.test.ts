import { describe, expect, it } from 'vitest';
import { destinosDe, eventoGa4, eventoMeta, EVENTOS_NAVEGADOR, EVENTOS_SERVIDOR } from './eventos.ts';

describe('§8 · mapeo evento interno → Meta', () => {
  it.each([
    ['PageView', 'PageView', 'website'],
    ['VideoPlay', 'ViewContent', 'website'],
    ['ClickCTA', 'Contact', 'website'],
    ['LeadCreado', 'Lead', 'website'],
    ['CitaConfirmada', 'Schedule', 'website'],
  ] as const)('%s → %s', (interno, meta, fuente) => {
    expect(eventoMeta(interno, {})).toEqual({ nombre: meta, actionSource: fuente });
  });

  it('TRK-09 · asistencia → evento offline system_generated solo si asistió', () => {
    expect(eventoMeta('AsistenciaRegistrada', { asistio: true })).toEqual({ nombre: 'CompleteRegistration', actionSource: 'system_generated' });
    expect(eventoMeta('AsistenciaRegistrada', { asistio: false })).toBeNull();
  });

  it('TRK-09 · contratación → evento offline custom `Contratado` system_generated (y GA4 candidate_hired)', () => {
    expect(EVENTOS_SERVIDOR).toContain('LeadContratado');
    expect(eventoMeta('LeadContratado', {})).toEqual({ nombre: 'Contratado', actionSource: 'system_generated' });
    expect(eventoGa4('LeadContratado')).toBe('candidate_hired');
    expect(destinosDe('LeadContratado', {}, { consentimiento: true, origen: 'navegador' })).toEqual([]);
    expect(destinosDe('LeadContratado', {}, { consentimiento: true, origen: 'servidor' })).toEqual(['meta', 'ga4']);
  });

  it.each(['ConsentAccepted', 'SectionView', 'VideoProgress50', 'VideoComplete', 'FormStarted', 'FormSubmitted', 'WhatsAppVerificado'] as const)(
    '%s no va a Meta',
    (n) => expect(eventoMeta(n, {})).toBeNull(),
  );
});

describe('mapeo a GA4', () => {
  it('nombres snake_case y ConsentAccepted solo en Supabase', () => {
    expect(eventoGa4('PageView')).toBe('page_view');
    expect(eventoGa4('SectionView')).toBe('section_view');
    expect(eventoGa4('LeadCreado')).toBe('generate_lead');
    expect(eventoGa4('ConsentAccepted')).toBeNull();
  });
});

describe('destinosDe · reglas de envío', () => {
  it('sin consentimiento no hay envío a terceros', () => {
    expect(destinosDe('PageView', {}, { consentimiento: false, origen: 'navegador' })).toEqual([]);
  });
  it('PageView con consentimiento → meta y ga4', () => {
    expect(destinosDe('PageView', {}, { consentimiento: true, origen: 'navegador' })).toEqual(['meta', 'ga4']);
  });
  it('SectionView → solo ga4', () => {
    expect(destinosDe('SectionView', {}, { consentimiento: true, origen: 'navegador' })).toEqual(['ga4']);
  });
  it('T8 · Schedule (CitaConfirmada) nunca desde el navegador', () => {
    expect(destinosDe('CitaConfirmada', {}, { consentimiento: true, origen: 'navegador' })).toEqual([]);
    expect(destinosDe('LeadCreado', {}, { consentimiento: true, origen: 'navegador' })).toEqual([]);
    expect(destinosDe('CitaConfirmada', {}, { consentimiento: true, origen: 'servidor' })).toEqual(['meta', 'ga4']);
  });
  it('los conjuntos de eventos de navegador y servidor son disjuntos', () => {
    for (const n of EVENTOS_NAVEGADOR) expect(EVENTOS_SERVIDOR as readonly string[]).not.toContain(n);
  });
});
