/**
 * TRK-03 · Clasificación del origen del tráfico (puro).
 * Prioridad: click ids de pago → UTM → referrer → directo.
 * Decisión documentada: `fbclid` sin UTM se clasifica como `organico_meta`, porque Meta
 * agrega fbclid también a los enlaces orgánicos; las campañas pagadas deben llevar UTM.
 */
export type Origen =
  | 'meta_pagado'
  | 'google_pagado'
  | 'organico_google'
  | 'organico_buscador'
  | 'organico_meta'
  | 'organico_social'
  | 'email'
  | 'referido'
  | 'directo'
  | 'otro';

export const ORIGENES: readonly Origen[] = [
  'meta_pagado', 'google_pagado', 'organico_google', 'organico_buscador', 'organico_meta', 'organico_social', 'email', 'referido', 'directo', 'otro',
];

export interface EntradaOrigen {
  utm_source?: string | null;
  utm_medium?: string | null;
  fbclid?: string | boolean | null;
  gclid?: string | boolean | null;
  referrer?: string | null;
  /** Host del propio sitio: un referrer interno cuenta como directo. */
  hostPropio?: string | null;
}

const FUENTES_META = new Set(['facebook', 'fb', 'instagram', 'ig', 'meta', 'messenger', 'audience_network', 'an', 'whatsapp']);
const FUENTES_GOOGLE = new Set(['google', 'adwords', 'googleads', 'google_ads', 'gads', 'youtube', 'yt']);
const FUENTES_SOCIAL = new Set(['linkedin', 'twitter', 'x', 'tiktok', 'pinterest', 'reddit', 'threads', 'snapchat']);
const FUENTES_EMAIL = /(^|[_-])(email|e-mail|mail|newsletter|mailchimp|sendgrid|brevo)([_-]|$)/;
const MEDIOS_PAGO = new Set(['cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'paid-social', 'cpm', 'cpv', 'ads', 'display', 'paid_search', 'sem']);
const MEDIOS_ORGANICOS = new Set(['organic', 'organico', 'social', 'social_organic', 'post', 'bio', 'story']);

const BUSCADORES = /(^|\.)(bing\.com|yahoo\.com|duckduckgo\.com|ecosia\.org|baidu\.com|yandex\.(ru|com)|search\.brave\.com)$/;
const GOOGLE_BUSCADOR = /(^|\.)google\.[a-z.]{2,6}$/;
const META_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|messenger\.com|threads\.net)$/;
const SOCIAL_HOSTS = /(^|\.)(linkedin\.com|lnkd\.in|t\.co|twitter\.com|x\.com|tiktok\.com|youtube\.com|youtu\.be|pinterest\.com|reddit\.com)$/;
const EMAIL_HOSTS = /^(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com)$/;

const limpio = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const presente = (v: string | boolean | null | undefined): boolean => (typeof v === 'string' ? v.trim().length > 0 : v === true);

export function hostDe(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function porUtm(fuente: string, medio: string): Origen {
  const pago = MEDIOS_PAGO.has(medio);
  const organico = MEDIOS_ORGANICOS.has(medio);
  if (medio === 'email' || FUENTES_EMAIL.test(fuente)) return 'email';
  if (FUENTES_META.has(fuente)) return organico ? 'organico_meta' : 'meta_pagado';
  if (FUENTES_GOOGLE.has(fuente)) return pago ? 'google_pagado' : 'organico_google';
  if (FUENTES_SOCIAL.has(fuente)) return pago ? 'otro' : 'organico_social';
  return 'otro';
}

function porReferrer(host: string | null, hostPropio: string): Origen {
  if (!host) return 'directo';
  if (hostPropio && (host === hostPropio || host.endsWith(`.${hostPropio}`))) return 'directo';
  if (EMAIL_HOSTS.test(host)) return 'email';
  if (GOOGLE_BUSCADOR.test(host)) return 'organico_google';
  if (BUSCADORES.test(host)) return 'organico_buscador';
  if (META_HOSTS.test(host)) return 'organico_meta';
  if (SOCIAL_HOSTS.test(host)) return 'organico_social';
  return 'referido';
}

export function clasificarOrigen(e: EntradaOrigen): Origen {
  if (presente(e.gclid)) return 'google_pagado';
  const fuente = limpio(e.utm_source);
  const medio = limpio(e.utm_medium);
  if (fuente || medio) return porUtm(fuente, medio);
  if (presente(e.fbclid)) return 'organico_meta';
  return porReferrer(hostDe(e.referrer), limpio(e.hostPropio).replace(/^www\./, ''));
}
