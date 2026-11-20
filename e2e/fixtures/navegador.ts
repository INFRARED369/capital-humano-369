/**
 * Stubs de TERCEROS del navegador (page.route): GTM/GA4, Meta Pixel, Clarity y Turnstile (stub que siempre pasa).
 * Registra lo que la página intenta cargar (p. ej. E2E-03: sin Clarity ni Meta si se rechazan cookies) y los
 * errores de JS/CSP. Supabase (edge functions, Auth y PostgREST) lo atiende `backend.ts`.
 */
import type { Page, Request, Route } from '@playwright/test';

export type Tercero = 'gtm' | 'ga4' | 'meta' | 'clarity' | 'turnstile' | 'stape';

const PATRONES_TERCEROS: Array<[Tercero, RegExp]> = [
  ['gtm', /googletagmanager\.com/],
  ['ga4', /google-analytics\.com|analytics\.google\.com/],
  ['meta', /connect\.facebook\.net|facebook\.com\/tr/],
  ['clarity', /clarity\.ms|c\.bing\.com/],
  ['turnstile', /challenges\.cloudflare\.com/],
  ['stape', /stape\.io/],
];

/** Turnstile falso: render() invoca el callback con un token de prueba. */
const STUB_TURNSTILE = `
  window.turnstile = {
    render: function (el, opts) { setTimeout(function () { opts && opts.callback && opts.callback('XXXX.DUMMY.TOKEN.XXXX'); }, 0); return 'widget-e2e'; },
    reset: function () {}, remove: function () {}, getResponse: function () { return 'XXXX.DUMMY.TOKEN.XXXX'; },
    execute: function (el, opts) { opts && opts.callback && opts.callback('XXXX.DUMMY.TOKEN.XXXX'); }
  };
  (function () { var s = document.currentScript; var cb = s && new URL(s.src).searchParams.get('onload'); if (cb && window[cb]) window[cb](); })();
`;
/** fbq/gtag/clarity falsos que solo registran en window.__terceros. */
const STUB_GENERICO = (t: Tercero) => `
  window.__terceros = window.__terceros || []; window.__terceros.push({ t: '${t}', carga: Date.now() });
  ${t === 'meta' ? "window.fbq = window.fbq || function () { window.__terceros.push({ t: 'meta', args: Array.from(arguments) }); };" : ''}
  ${t === 'clarity' ? "window.clarity = window.clarity || function () { window.__terceros.push({ t: 'clarity', args: Array.from(arguments) }); };" : ''}
`;

export interface RegistroTerceros {
  solicitudes: Record<Tercero, string[]>;
  erroresPagina: string[];
  violacionesCsp: string[];
}

export async function stubTerceros(page: Page): Promise<RegistroTerceros> {
  const reg: RegistroTerceros = {
    solicitudes: { gtm: [], ga4: [], meta: [], clarity: [], turnstile: [], stape: [] },
    erroresPagina: [],
    violacionesCsp: [],
  };
  await page.route(
    (url) => PATRONES_TERCEROS.some(([, re]) => re.test(url.href)),
    async (route: Route, req: Request) => {
      const t = PATRONES_TERCEROS.find(([, re]) => re.test(req.url()))![0];
      reg.solicitudes[t].push(req.url());
      if (req.resourceType() === 'script')
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: t === 'turnstile' ? STUB_TURNSTILE : STUB_GENERICO(t) });
      if (req.resourceType() === 'image') return route.fulfill({ status: 204 });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    },
  );
  // NFR-SEG-07: toda violación de CSP (evento del DOM, independiente del idioma de la consola y del motor)
  // queda registrada; el fixture `terceros` FALLA el test si hubo alguna (script-src va sin 'unsafe-inline').
  await page.exposeBinding('__e2eViolacionCsp', (_o, v: string) => void reg.violacionesCsp.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const f = (window as unknown as { __e2eViolacionCsp?: (v: string) => void }).__e2eViolacionCsp;
      f?.(`securitypolicyviolation ${e.effectiveDirective} bloqueó ${e.blockedURI || 'inline'} (${e.sourceFile}:${e.lineNumber}) ${e.sample}`);
    });
  });
  page.on('pageerror', (e) => reg.erroresPagina.push(e.message));
  return reg;
}
