/**
 * API pública del SDK de tracking del navegador (dueño: dominio tracking).
 * Firmas estables del contrato (captación y panel programan contra ellas):
 *   track(nombre, props?, eventId?) → event_id · obtenerAtribucion() · tieneConsentimiento() · fijarContextoVacante(ctx)
 * Componentes: <TrackingProvider/> y <ConsentBanner/> (apps/web/components/tracking, re-exportados aquí).
 */
import { uuidv7 } from '../../../../src/shared/ids';
import { obtenerTracker } from './instancia';
import type { Atribucion, ContextoVacante, NombreEventoFunnel } from './sdk';

export type { Atribucion, ContextoVacante, EstadoConsentimiento, NombreEventoFunnel, Tracker } from './sdk';
export { obtenerTracker, __fijarTracker } from './instancia';
export { rutaSinTerceros, PREFIJOS_SIN_TERCEROS } from './rutas';
export { TrackingProvider } from '../../components/tracking/TrackingProvider';
export { ConsentBanner, BotonPreferenciasCookies } from '../../components/tracking/ConsentBanner';

/** Envía un evento del funnel (respeta consentimiento). Devuelve el event_id (UUID v7). */
export function track(nombre: NombreEventoFunnel, props: Record<string, unknown> = {}, eventId?: string): string {
  return obtenerTracker()?.track(nombre, props, eventId) ?? eventId ?? uuidv7();
}
/** Atribución persistida (vacía sin consentimiento). */
export function obtenerAtribucion(): Atribucion {
  return obtenerTracker()?.obtenerAtribucion() ?? { visitor_id: null };
}
export function tieneConsentimiento(): boolean {
  return obtenerTracker()?.tieneConsentimiento() ?? false;
}
export function fijarContextoVacante(ctx: ContextoVacante | null): void {
  obtenerTracker()?.fijarContextoVacante(ctx);
}
