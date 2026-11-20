import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { TrackingProvider } from '../components/tracking/TrackingProvider';
import { ConsentBanner } from '../components/tracking/ConsentBanner';

export const metadata: Metadata = {
  title: '369 Capital Humano',
  description: 'Reclutamiento y selección de talento con claridad, velocidad y permanencia.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b0b0f' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-MX">
      <body>
        <TrackingProvider>
          {children}
          <ConsentBanner />
        </TrackingProvider>
      </body>
    </html>
  );
}
