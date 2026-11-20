/** Recursos estáticos optimizados (NFR-RND-01): imágenes a 480 px de ancho (≥ 2x del tamaño mostrado) y fuentes propias. */
import { preload } from 'react-dom';

export const IMG = {
  logo: { src: '/logo-369-480.webp', width: 480, height: 227 },
  marca: { src: '/brand-369-mark-480.webp', width: 480, height: 266 },
  marcaNaranja: { src: '/brand-369-orange-480.webp', width: 480, height: 227 },
} as const;

/** Precarga las fuentes del primer render (títulos y cuerpo) para que no se descubran tarde vía CSS. */
export function precargarFuentes(): void {
  for (const f of ['/fonts/space-grotesk.woff2', '/fonts/manrope.woff2']) preload(f, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
}
