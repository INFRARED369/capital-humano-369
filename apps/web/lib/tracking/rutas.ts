/**
 * Rutas internas sin terceros (Pixel, Clarity) ni ingesta: el panel (datos de candidatos) y la gestión de la cita
 * (`/cita/?t=` lleva un token firmado). Ahí el SDK no se inicia, no se pide consentimiento y no se emite PageView.
 */
export const PREFIJOS_SIN_TERCEROS = ['/panel', '/cita'] as const;

export function rutaSinTerceros(pathname: string | null | undefined): boolean {
  const ruta = (pathname ?? '').toLowerCase();
  return PREFIJOS_SIN_TERCEROS.some((p) => ruta === p || ruta.startsWith(`${p}/`));
}
