/** Adaptador de Cloudflare Turnstile (AntiBotPort). El secreto vive solo en la edge function (TURNSTILE_SECRET). */
import type { AntiBotPort } from '../../application/puertos.ts';

export const URL_SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function crearTurnstileAdapter(cfg: { secret: string; timeoutMs?: number; url?: string }, fetchImpl: typeof fetch = fetch): AntiBotPort {
  if (!cfg.secret) throw new Error('TURNSTILE_SECRET requerido');
  // TURNSTILE_URL solo para pruebas locales contra un mock; en producción siempre Cloudflare por HTTPS.
  const url = cfg.url ?? URL_SITEVERIFY;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?\//.test(url)) {
    throw new Error('TURNSTILE_URL debe ser https (o http solo en localhost para pruebas)');
  }
  return {
    async verificar(token, ip) {
      const body = new URLSearchParams({ secret: cfg.secret, response: token });
      if (ip) body.set('remoteip', ip);
      const r = await fetchImpl(url, { method: 'POST', body, signal: AbortSignal.timeout(cfg.timeoutMs ?? 5000) });
      if (!r.ok) throw new Error(`Turnstile HTTP ${r.status}`);
      const j = (await r.json()) as { success?: boolean };
      return j.success === true;
    },
  };
}
