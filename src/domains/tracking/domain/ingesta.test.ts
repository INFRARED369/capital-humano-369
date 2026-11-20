import { describe, expect, it } from 'vitest';
import { EventoNavegadorSchema } from './ingesta.ts';

const valido = {
  v: 1,
  event_id: '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e',
  nombre: 'PageView',
  consentimiento: true,
  visitor_id: '01934f6e-0000-7000-8000-000000000001',
  pagina: '/vacantes/agente-smart/',
  referrer: 'https://www.google.com/',
  atribucion: { utm_source: 'facebook', utm_campaign: 'ventas-nov', fbclid: 'IwAR1', fbc: 'fb.1.1700000000000.IwAR1', fbp: 'fb.1.1700000000000.42' },
  custom_data: { vacancy_id: 'agente-smart', client_id: '0b6f2c1e-6a43-4d34-9b8e-6d7c3a2f1e00', content_category: 'ventas' },
  props: { seccion: 'beneficios', porcentaje: 50 },
};

describe('TRK-06 · validación Zod estricta de la ingesta', () => {
  it('acepta un evento válido', () => {
    expect(EventoNavegadorSchema.safeParse(valido).success).toBe(true);
  });
  it('rechaza campos extra', () => {
    expect(EventoNavegadorSchema.safeParse({ ...valido, telefono: '8112345678' }).success).toBe(false);
    expect(EventoNavegadorSchema.safeParse({ ...valido, atribucion: { ...valido.atribucion, email: 'x@y.z' } }).success).toBe(false);
  });
  it('T8 · rechaza eventos que solo emite el servidor (Schedule/CitaConfirmada/LeadCreado)', () => {
    for (const nombre of ['CitaConfirmada', 'Schedule', 'LeadCreado', 'AsistenciaRegistrada']) {
      expect(EventoNavegadorSchema.safeParse({ ...valido, nombre }).success).toBe(false);
    }
  });
  it('rechaza event_id que no es UUID y props con objetos o demasiadas llaves', () => {
    expect(EventoNavegadorSchema.safeParse({ ...valido, event_id: 'x' }).success).toBe(false);
    expect(EventoNavegadorSchema.safeParse({ ...valido, props: { a: { b: 1 } } }).success).toBe(false);
    const muchas = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i]));
    expect(EventoNavegadorSchema.safeParse({ ...valido, props: muchas }).success).toBe(false);
    expect(EventoNavegadorSchema.safeParse({ ...valido, props: { s: 'x'.repeat(201) } }).success).toBe(false);
  });
  it('sin consentimiento no admite visitor_id ni cookies de marketing', () => {
    expect(EventoNavegadorSchema.safeParse({ ...valido, consentimiento: false }).success).toBe(false);
    const anonimo = { v: 1, event_id: valido.event_id, nombre: 'PageView', consentimiento: false, pagina: '/', atribucion: { utm_source: 'facebook', tiene_fbclid: true } };
    expect(EventoNavegadorSchema.safeParse(anonimo).success).toBe(true);
    expect(EventoNavegadorSchema.safeParse({ ...anonimo, atribucion: { fbp: 'fb.1.1.1' } }).success).toBe(false);
  });
  it('con consentimiento exige visitor_id', () => {
    const { visitor_id: _v, ...sinVid } = valido;
    expect(EventoNavegadorSchema.safeParse(sinVid).success).toBe(false);
  });
  it('rechaza página que no es ruta y vacancy_id con caracteres raros', () => {
    expect(EventoNavegadorSchema.safeParse({ ...valido, pagina: 'javascript:alert(1)' }).success).toBe(false);
    expect(EventoNavegadorSchema.safeParse({ ...valido, custom_data: { vacancy_id: '<x>' } }).success).toBe(false);
  });
});
