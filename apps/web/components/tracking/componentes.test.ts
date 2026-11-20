import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsentBanner, ConsentBannerVista, vistaBanner } from './ConsentBanner';
import { TrackingProvider } from './TrackingProvider';
import { __fijarTracker } from '../../lib/tracking/instancia';
import type { Tracker } from '../../lib/tracking/sdk';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const trackerFalso = (estado: 'aceptado' | 'rechazado' | null, iniciado = true): Tracker =>
  ({ iniciado: () => iniciado, estadoConsentimiento: () => estado, suscribir: () => () => undefined }) as unknown as Tracker;

afterEach(() => __fijarTracker(null));

describe('TRK-01 · <ConsentBanner/> accesible', () => {
  it('es un diálogo no modal etiquetado, con Aceptar y Rechazar como botones y enlace al aviso', () => {
    const html = renderToStaticMarkup(createElement(ConsentBannerVista, { onAceptar: () => {}, onRechazar: () => {}, versionAviso: 'v1' }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    expect(html).toMatch(/aria-labelledby="ch369-consent-titulo"[^>]*aria-describedby="ch369-consent-desc"/);
    expect(html).toContain('id="ch369-consent-titulo"');
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(html).toMatch(/>Rechazar<\/button>.*>Aceptar<\/button>/);
    expect(html).toContain('href="/aviso-de-privacidad/"');
    expect(html).toContain('min-height:44px');
  });

  it('solo se muestra cuando el SDK ya inició y no hay decisión', () => {
    expect(vistaBanner()).toBe('oculto'); // SSR / sin tracker
    __fijarTracker(trackerFalso(null, false));
    expect(vistaBanner()).toBe('oculto');
    __fijarTracker(trackerFalso('aceptado'));
    expect(vistaBanner()).toBe('oculto');
    __fijarTracker(trackerFalso(null));
    expect(vistaBanner()).toBe('preguntar');
  });

  it('en el render de servidor (export estático) no emite el banner', () => {
    expect(renderToStaticMarkup(createElement(ConsentBanner))).toBe('');
  });

  it('<TrackingProvider/> renderiza a sus hijos sin envoltorios', () => {
    expect(renderToStaticMarkup(createElement(TrackingProvider, null, createElement('main', null, 'hola')))).toBe('<main>hola</main>');
  });
});
