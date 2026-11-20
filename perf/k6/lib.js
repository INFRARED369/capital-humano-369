// Utilidades comunes de k6 (F7.3). Solo contra STAGING con:
//  - TURNSTILE_SECRET de prueba (1x0000000000000000000000000000000AA: siempre pasa),
//  - EVOLUTION_URL/NBX/SMTP apuntando a mocks (no mandar 50 OTP/s reales),
//  - rate limit por IP relajado (k6 sale de una sola IP). Ver docs/runbook.md §Pruebas de carga.
import { check } from 'k6';

export const FUNCIONES_URL = (__ENV.FUNCIONES_URL || '').replace(/\/$/, '');
export const ORIGEN = __ENV.ORIGEN || 'https://staging.369capitalhumano.com';
export const VACANTE_ID = __ENV.VACANTE_ID || '';
export const VACANTE_SLUG = __ENV.VACANTE_SLUG || 'agente-smart';

if (!FUNCIONES_URL) throw new Error('Falta FUNCIONES_URL (p. ej. https://<ref>.supabase.co/functions/v1)');

export const HEADERS = { 'content-type': 'application/json', origin: ORIGEN };

/** UUID v7 aproximado (ordenable por tiempo) para event_id. */
export function uuidv7() {
  const ms = Date.now().toString(16).padStart(12, '0');
  const r = () => Math.floor(Math.random() * 16).toString(16);
  const rnd = (n) => Array.from({ length: n }, r).join('');
  const variante = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${rnd(3)}-${variante}${rnd(3)}-${rnd(12)}`;
}

/** Teléfono MX sintético (prefijo 5299 reservado para pruebas de carga). */
export function telefonoPrueba() {
  return `5299${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

export function verificar(res, nombre, estados) {
  return check(res, { [`${nombre}: estado ${estados.join('/')}`]: (r) => estados.includes(r.status) });
}
