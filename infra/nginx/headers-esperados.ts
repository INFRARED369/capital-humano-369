/**
 * Política de headers de seguridad esperada (NFR-SEG-07, E2E-14). Fuente única para:
 *  - infra/nginx/nginx.test.ts (verifica la configuración de Nginx), y
 *  - e2e/headers.spec.ts (verifica la respuesta real: serve-out local o STAGING_URL).
 */
import { parsearCsp } from '../../scripts/lib/nginx-conf.mjs';

/** Orígenes de terceros que la CSP debe permitir (por directiva). */
export const CSP_REQUERIDA: Record<string, string[]> = {
  'default-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'script-src': [
    "'self'",
    'https://www.googletagmanager.com', // GTM / GA4
    'https://connect.facebook.net', // Meta Pixel
    'https://www.clarity.ms', // Clarity
    'https://challenges.cloudflare.com', // Turnstile
  ],
  'connect-src': [
    "'self'",
    'https://*.supabase.co', // edge functions
    'https://*.google-analytics.com',
    'https://www.facebook.com',
    'https://*.clarity.ms',
    'https://*.stape.io', // Stape (GTM server-side)
  ],
  'frame-src': ['https://challenges.cloudflare.com'],
  'img-src': ["'self'", 'https://www.facebook.com'],
};

/** Fuentes que NUNCA deben aparecer en la CSP. */
export const CSP_PROHIBIDO: Array<[string, string]> = [
  ['script-src', "'unsafe-eval'"],
  // Scripts inline permitidos solo por hash (scripts/csp-hashes.mjs).
  ['script-src', "'unsafe-inline'"],
  ['script-src', '*'],
  ['script-src', 'http:'],
  ['script-src', 'data:'],
  ['default-src', '*'],
  ['connect-src', '*'],
];

export const HEADERS_REQUERIDOS = [
  'content-security-policy',
  'strict-transport-security',
  'x-frame-options',
  'referrer-policy',
  'x-content-type-options',
  'permissions-policy',
] as const;

export interface OpcionesVerificacion {
  /** HSTS solo se exige sobre HTTPS (staging/producción); en serve-out local es informativo. */
  exigirHsts?: boolean;
}

/** Devuelve la lista de incumplimientos (vacía = OK). `headers` con nombres en minúsculas. */
export function verificarHeaders(headers: Record<string, string | undefined>, opts: OpcionesVerificacion = {}): string[] {
  const errores: string[] = [];
  const exigirHsts = opts.exigirHsts ?? true;
  for (const h of HEADERS_REQUERIDOS) {
    if (h === 'strict-transport-security' && !exigirHsts) continue;
    if (!headers[h]) errores.push(`falta ${h}`);
  }
  const hsts = headers['strict-transport-security'];
  if (hsts) {
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (maxAge < 31536000) errores.push(`HSTS max-age < 1 año (${maxAge})`);
    if (!/includesubdomains/i.test(hsts)) errores.push('HSTS sin includeSubDomains');
  }
  if (headers['x-frame-options'] && headers['x-frame-options'].toUpperCase() !== 'DENY') errores.push('X-Frame-Options debe ser DENY');
  if (headers['referrer-policy'] && headers['referrer-policy'] !== 'strict-origin-when-cross-origin')
    errores.push('Referrer-Policy debe ser strict-origin-when-cross-origin');
  if (headers['x-content-type-options'] && headers['x-content-type-options'] !== 'nosniff') errores.push('X-Content-Type-Options debe ser nosniff');
  const pp = headers['permissions-policy'];
  if (pp) for (const f of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) if (!pp.includes(f)) errores.push(`Permissions-Policy sin ${f}`);
  if (headers['server'] && /\d/.test(headers['server'])) errores.push(`el header Server expone versión (${headers['server']})`);
  if (headers['x-powered-by']) errores.push('X-Powered-By presente');

  const cspTexto = headers['content-security-policy'];
  if (cspTexto) {
    const csp = parsearCsp(cspTexto);
    for (const [dir, fuentes] of Object.entries(CSP_REQUERIDA)) {
      for (const f of fuentes) if (!csp[dir]?.includes(f)) errores.push(`CSP ${dir} sin ${f}`);
    }
    for (const [dir, f] of CSP_PROHIBIDO) if (csp[dir]?.includes(f)) errores.push(`CSP ${dir} no debe incluir ${f}`);
  }
  return errores;
}
