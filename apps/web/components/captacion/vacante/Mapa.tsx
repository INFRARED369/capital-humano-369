'use client';
import { useState } from 'react';

/**
 * Mapa con fachada: el iframe de Google Maps (~600 KB de JS y cookies de terceros) solo se carga cuando la persona
 * lo pide. Mejora el LCP en 4G (NFR-RND-01) y evita contactar a Google antes del consentimiento (TRK-01).
 */
export function MapaDiferido({ titulo, src, direccion }: { titulo: string; src: string; direccion: string }) {
  const [visible, setVisible] = useState(false);
  if (visible) return <iframe className="map-frame" title={titulo} loading="lazy" referrerPolicy="no-referrer-when-downgrade" src={src}></iframe>;
  return (
    <div className="map-frame map-fachada">
      <p><span aria-hidden="true">📍</span> {direccion}</p>
      <button type="button" className="btn btn-navy btn-sm" onClick={() => setVisible(true)}>Ver mapa interactivo</button>
      <small>Al abrir el mapa se conecta con Google Maps.</small>
    </div>
  );
}
