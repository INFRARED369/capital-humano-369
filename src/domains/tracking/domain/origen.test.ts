import { describe, expect, it } from 'vitest';
import { clasificarOrigen } from './origen.ts';

describe('TRK-03 · clasificarOrigen', () => {
  it('T1 · utm_source=facebook con fbclid → meta_pagado', () => {
    expect(clasificarOrigen({ utm_source: 'facebook', fbclid: 'IwAR123' })).toBe('meta_pagado');
  });
  it('T2 · sin UTM con referrer de Google → organico_google', () => {
    expect(clasificarOrigen({ referrer: 'https://www.google.com/' })).toBe('organico_google');
    expect(clasificarOrigen({ referrer: 'https://www.google.com.mx/search?q=empleo' })).toBe('organico_google');
  });

  it.each([
    [{ utm_source: 'Instagram', utm_medium: 'paid_social' }, 'meta_pagado'],
    [{ utm_source: 'fb', utm_medium: 'cpc' }, 'meta_pagado'],
    [{ utm_source: 'facebook' }, 'meta_pagado'],
    [{ utm_source: 'facebook', utm_medium: 'social' }, 'organico_meta'],
    [{ fbclid: true }, 'organico_meta'],
    [{ gclid: 'abc' }, 'google_pagado'],
    [{ gclid: 'abc', referrer: 'https://www.google.com/' }, 'google_pagado'],
    [{ utm_source: 'google', utm_medium: 'cpc' }, 'google_pagado'],
    [{ utm_source: 'youtube', utm_medium: 'paid' }, 'google_pagado'],
    [{ utm_source: 'google', utm_medium: 'organic' }, 'organico_google'],
    [{ utm_source: 'newsletter', utm_medium: 'email' }, 'email'],
    [{ utm_source: 'mailchimp' }, 'email'],
    [{ utm_source: 'linkedin', utm_medium: 'social' }, 'organico_social'],
    [{ utm_source: 'tiktok', utm_medium: 'cpc' }, 'otro'],
    [{ utm_source: 'volante', utm_medium: 'qr' }, 'otro'],
    [{}, 'directo'],
    [{ referrer: '' }, 'directo'],
    [{ referrer: 'no es url' }, 'directo'],
    [{ referrer: 'https://capitalhumano369.com/vacantes/', hostPropio: 'capitalhumano369.com' }, 'directo'],
    [{ referrer: 'https://www.bing.com/' }, 'organico_buscador'],
    [{ referrer: 'https://duckduckgo.com/' }, 'organico_buscador'],
    [{ referrer: 'https://l.facebook.com/l.php' }, 'organico_meta'],
    [{ referrer: 'https://www.instagram.com/' }, 'organico_meta'],
    [{ referrer: 'https://www.linkedin.com/feed' }, 'organico_social'],
    [{ referrer: 'https://t.co/abc' }, 'organico_social'],
    [{ referrer: 'https://mail.google.com/' }, 'email'],
    [{ referrer: 'https://www.occ.com.mx/empleos' }, 'referido'],
  ] as const)('%j → %s', (entrada, esperado) => {
    expect(clasificarOrigen(entrada)).toBe(esperado);
  });
});
