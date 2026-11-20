'use client';
/**
 * TRK-01 · Banner de consentimiento (no modal, accesible: WCAG 2.1 AA).
 * Aceptar y Rechazar tienen el mismo peso visual. Sin decisión no se carga ningún tercero.
 */
import { useCallback, useSyncExternalStore, type CSSProperties } from 'react';
import { obtenerTracker } from '../../lib/tracking/instancia';
import { configPublica } from '../../lib/config';

type Vista = 'oculto' | 'preguntar';

export function vistaBanner(): Vista {
  const t = obtenerTracker();
  if (!t || !t.iniciado()) return 'oculto';
  return t.estadoConsentimiento() === null ? 'preguntar' : 'oculto';
}

const estilos: Record<'caja' | 'acciones' | 'boton' | 'texto', CSSProperties> = {
  caja: { position: 'fixed', insetInline: '1rem', bottom: '1rem', zIndex: 1000, maxWidth: '40rem', marginInline: 'auto', padding: '1rem 1.25rem', borderRadius: '0.75rem', background: '#0b0b0f', color: '#ffffff', boxShadow: '0 8px 24px rgba(0,0,0,.35)', fontSize: '0.95rem', lineHeight: 1.5 },
  texto: { margin: '0.25rem 0 0.75rem' },
  acciones: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap' },
  boton: { minHeight: '44px', minWidth: '44px', padding: '0.5rem 1.25rem', borderRadius: '0.5rem', border: '2px solid #ffffff', background: '#ffffff', color: '#0b0b0f', fontWeight: 600, cursor: 'pointer' },
};

export interface ConsentBannerVistaProps { onAceptar: () => void; onRechazar: () => void; urlAviso?: string; versionAviso?: string }

/** Presentación pura (probada con renderToStaticMarkup). */
export function ConsentBannerVista({ onAceptar, onRechazar, urlAviso = '/aviso-de-privacidad/', versionAviso = configPublica.versionAviso }: ConsentBannerVistaProps) {
  return (
    <section role="dialog" aria-modal="false" aria-labelledby="ch369-consent-titulo" aria-describedby="ch369-consent-desc" data-version-aviso={versionAviso} style={estilos.caja}>
      <h2 id="ch369-consent-titulo" style={{ margin: 0, fontSize: '1.05rem' }}>Tu privacidad</h2>
      <p id="ch369-consent-desc" style={estilos.texto}>
        Usamos cookies propias y de terceros (Meta, Google y Microsoft Clarity) para medir campañas y mejorar el sitio.
        Solo se activan si aceptas. Consulta el <a href={urlAviso} style={{ color: '#ffffff', textDecoration: 'underline' }}>aviso de privacidad</a>.
      </p>
      <div style={estilos.acciones}>
        <button type="button" onClick={onRechazar} style={estilos.boton}>Rechazar</button>
        <button type="button" onClick={onAceptar} style={estilos.boton}>Aceptar</button>
      </div>
    </section>
  );
}

export function ConsentBanner({ urlAviso }: { urlAviso?: string } = {}) {
  const suscribir = useCallback((fn: () => void) => obtenerTracker()?.suscribir(fn) ?? (() => undefined), []);
  const vista = useSyncExternalStore(suscribir, vistaBanner, () => 'oculto' as Vista);
  if (vista === 'oculto') return null;
  return <ConsentBannerVista urlAviso={urlAviso} onAceptar={() => obtenerTracker()?.aceptar()} onRechazar={() => obtenerTracker()?.rechazar()} />;
}

/** Permite cambiar la decisión en cualquier momento (revocación, LFPDPPP). */
export function BotonPreferenciasCookies({ children = 'Preferencias de cookies' }: { children?: string }) {
  return (
    <button type="button" onClick={() => obtenerTracker()?.reabrir()} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0, minHeight: '24px' }}>
      {children}
    </button>
  );
}
