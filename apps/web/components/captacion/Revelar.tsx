'use client';
import { useEffect } from 'react';
import { track } from '../../lib/tracking';

/** Animación de entrada (.reveal → .in-view) y evento SectionView por sección visible (una vez). */
export function Revelar({ secciones = true }: { secciones?: boolean }) {
  useEffect(() => {
    const vistos = new Set<string>();
    const obs = new IntersectionObserver(
      (entradas) => {
        for (const e of entradas) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          if (el.classList.contains('reveal')) el.classList.add('in-view');
          if (el.tagName === 'SECTION' && el.id && !vistos.has(el.id)) {
            vistos.add(el.id);
            if (secciones) track('SectionView', { section: el.id });
          }
          obs.unobserve(el);
        }
      },
      { threshold: 0.12 },
    );
    document.querySelectorAll('.reveal, section[id]').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [secciones]);
  return null;
}
