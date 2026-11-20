'use client';
import { useEffect, useRef } from 'react';
import { configPublica } from '../../lib/config';

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, o: Record<string, unknown>): string;
      reset(id?: string): void;
      remove(id: string): void;
    };
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let carga: Promise<void> | null = null;

function cargarScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  carga ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { carga = null; reject(new Error('turnstile')); };
    document.head.appendChild(s);
  });
  return carga;
}

/**
 * Widget anti-bot (NFR-SEG-03). El token se verifica en el servidor. Cambia `reinicio` para pedir un token nuevo
 * (son de un solo uso). Si el script no carga, avisa con onError para ofrecer el respaldo por WhatsApp.
 */
export function Turnstile({ onToken, onError, reinicio = 0 }: { onToken: (t: string) => void; onError?: () => void; reinicio?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef({ onToken, onError });
  cb.current = { onToken, onError };

  useEffect(() => {
    let id: string | null = null;
    let vivo = true;
    cargarScript()
      .then(() => {
        if (!vivo || !ref.current || !window.turnstile) return;
        id = window.turnstile.render(ref.current, {
          sitekey: configPublica.turnstileSiteKey,
          language: 'es',
          callback: (t: string) => cb.current.onToken(t),
          'expired-callback': () => cb.current.onToken(''),
          'error-callback': () => cb.current.onError?.(),
        });
      })
      .catch(() => cb.current.onError?.());
    return () => {
      vivo = false;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [reinicio]);

  return <div ref={ref} className="turnstile-box" />;
}
