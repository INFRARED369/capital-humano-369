import { describe, expect, it } from 'vitest';
import { formatearAlertas, payloadWebhook, sanearDetalle, type Alerta } from './alertas.ts';

const a = (over: Partial<Alerta> = {}): Alerta => ({
  id: '1', tipo: 'dead_letter', severidad: 'critica', clave: 'dead_letter:comunicacion:9', creadaEn: '2026-11-17T18:00:00.000Z',
  detalle: { cola: 'comunicacion', nuevas: 2, hasta_id: 9 }, ...over,
});

describe('sanearDetalle (sin PII en notificaciones)', () => {
  it('lista blanca de claves: conserva números, códigos cortos, listas de códigos y null; descarta el resto', () => {
    expect(sanearDetalle({
      cola: 'comunicacion', nuevas: 2, tasa: 0.2, errores: ['tracking', 'citas'], ejecutado_en: '2026-11-17T17:00:00+00:00', ultima: null,
      motivo: 'HTTP_400', email: 'ana@x.mx', telefono: 8112345678, anidado: { a: 1 }, texto: 'Hola', emitidos: true,
    })).toEqual({ cola: 'comunicacion', nuevas: 2, tasa: 0.2, errores: ['tracking', 'citas'], ejecutado_en: '2026-11-17T17:00:00+00:00', ultima: null });
  });
  it('descarta códigos demasiado largos o con espacios y números que parecen teléfonos', () => {
    expect(sanearDetalle({ cola: 'x'.repeat(61), zoho_tipo: 'ZOHO DRIFT', nuevas: 5212345678901, hasta_id: 1234567890 })).toEqual({ hasta_id: 1234567890 });
  });
});

describe('formatearAlertas', () => {
  it('asunto con conteo y severidad máxima; una línea por alerta en orden de severidad', () => {
    const r = formatearAlertas([a({ severidad: 'aviso', tipo: 'zoho', clave: 'zoho:ZOHO_DRIFT:3', detalle: { zoho_tipo: 'ZOHO_DRIFT', nuevas: 1 } }), a()], { entorno: 'produccion' });
    expect(r.asunto).toBe('[369 · produccion] 2 alerta(s), 1 crítica(s)');
    expect(r.texto.split('\n')).toEqual([
      '[369 · produccion] 2 alerta(s), 1 crítica(s)',
      '[CRITICA] dead_letter · cola=comunicacion nuevas=2 hasta_id=9',
      '[AVISO] zoho · zoho_tipo=ZOHO_DRIFT nuevas=1',
      'Detalle: tabla shared.alertas y docs/runbook.md §8.',
    ]);
  });
  it('sin entorno → etiqueta genérica; lista vacía → asunto sin críticas', () => {
    expect(formatearAlertas([]).asunto).toBe('[369] 0 alerta(s)');
    expect(formatearAlertas([a({ detalle: { errores: ['citas', 'tracking'] }, tipo: 'retencion_errores' })]).texto).toContain('errores=citas,tracking');
  });
});

describe('payloadWebhook', () => {
  it('compatible con Slack (text) y Discord (content) y lista estructurada sin PII', () => {
    const p = payloadWebhook([a({ detalle: { cola: 'comunicacion', motivo: 'tel 8112345678' } })]);
    expect(p.text).toBe(p.content);
    expect(p.alertas).toEqual([{ tipo: 'dead_letter', severidad: 'critica', clave: 'dead_letter:comunicacion:9', creada_en: '2026-11-17T18:00:00.000Z', detalle: { cola: 'comunicacion' } }]);
    expect(JSON.stringify(p)).not.toContain('8112345678');
  });
  it('Discord limita content a 2000 caracteres', () => {
    const muchas = Array.from({ length: 200 }, (_, i) => a({ id: String(i), clave: `k${i}` }));
    expect(payloadWebhook(muchas).content.length).toBeLessThanOrEqual(2000);
  });
});
