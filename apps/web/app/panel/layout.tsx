import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../../components/panel/panel.css';

/** Panel interno (F6, DSH-01..06): SPA estática con Supabase Auth. No se indexa. */
export const metadata: Metadata = {
  title: { default: 'Panel | 369 Capital Humano', template: '%s · Panel 369' },
  robots: { index: false, follow: false },
  referrer: 'same-origin',
};

export default function LayoutPanel({ children }: { children: ReactNode }) {
  return children;
}
