/** Tracker único de la página (singleton perezoso). En SSR/build no hay window → null. */
import { configPublica } from '../config';
import { crearTracker, depsNavegador, type Tracker } from './sdk';

let instancia: Tracker | null = null;

export function obtenerTracker(): Tracker | null {
  if (instancia) return instancia;
  if (typeof window === 'undefined') return null;
  instancia = crearTracker(
    depsNavegador({
      ingestUrl: `${configPublica.funcionesUrl}/tracking-ingest`,
      pixelId: configPublica.metaPixelId,
      clarityId: configPublica.clarityId,
      versionAviso: configPublica.versionAviso,
    }),
  );
  return instancia;
}

/** Solo pruebas: inyecta un tracker (o null para reiniciar). */
export function __fijarTracker(t: Tracker | null): void {
  instancia = t;
}
