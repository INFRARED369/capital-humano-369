'use client';
/**
 * Monta el SDK de tracking: inicia (lee la decisión de consentimiento), emite PageView por ruta
 * y, si el visitante nunca decide, envía los eventos retenidos como conteo anónimo al ocultar la página.
 * En /panel/ y /cita/ (rutaSinTerceros) no hace nada: sin Pixel, Clarity, banner ni ingesta.
 */
import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { obtenerTracker } from '../../lib/tracking/instancia';
import { rutaSinTerceros } from '../../lib/tracking/rutas';

export function TrackingProvider({ children }: { children: ReactNode }) {
  const ruta = usePathname();
  const excluida = rutaSinTerceros(ruta);

  useEffect(() => {
    // Se decide con la URL real (export estático: la ruta del documento es la que cuenta).
    if (excluida || rutaSinTerceros(window.location.pathname)) return;
    const t = obtenerTracker();
    t?.iniciar();
    const alOcultar = () => {
      if (document.visibilityState === 'hidden') t?.alOcultarPagina();
    };
    const alSalir = () => t?.alOcultarPagina();
    document.addEventListener('visibilitychange', alOcultar);
    window.addEventListener('pagehide', alSalir);
    return () => {
      document.removeEventListener('visibilitychange', alOcultar);
      window.removeEventListener('pagehide', alSalir);
    };
  }, [excluida]);

  useEffect(() => {
    if (!excluida) obtenerTracker()?.track('PageView');
  }, [ruta, excluida]);

  return <>{children}</>;
}
