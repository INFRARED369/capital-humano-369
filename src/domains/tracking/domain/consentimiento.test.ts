import { describe, expect, it } from 'vitest';
import { sanearSegunConsentimiento } from './consentimiento.ts';

const crudo = {
  consentimiento: true,
  visitorId: 'v', ip: '1.2.3.4', userAgent: 'UA', fbc: 'fb.1.1.x', fbp: 'fb.1.1.y', gclid: 'g', fbclid: 'f',
};

describe('política: sin consentimiento no se guarda IP, cookie ni visitor_id', () => {
  it('con consentimiento conserva los identificadores', () => {
    expect(sanearSegunConsentimiento(crudo)).toEqual(crudo);
  });
  it('sin consentimiento los elimina todos', () => {
    expect(sanearSegunConsentimiento({ ...crudo, consentimiento: false })).toEqual({
      consentimiento: false, visitorId: null, ip: null, userAgent: null, fbc: null, fbp: null, gclid: null, fbclid: null,
    });
  });
});
