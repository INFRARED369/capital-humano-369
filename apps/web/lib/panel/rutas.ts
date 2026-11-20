/**
 * Rutas del panel con export estático (sin rutas dinámicas). Formato canónico del detalle de cita:
 *   /panel/citas/?id=<uuid>
 * También se aceptan `#id=<uuid>`, `#<uuid>` y `/panel/citas/<uuid>/` (formato que hoy genera Zoho; requiere
 * que Nginx sirva /panel/citas/index.html para esa ruta — ver docs/bitacora/panel.md).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (v: string | null | undefined): string | null => (v && UUID.test(v) ? v.toLowerCase() : null);

export const esUuid = (v: string | null | undefined): v is string => !!v && UUID.test(v);

export function leerParam(search: string, nombre: string): string | null {
  return new URLSearchParams(search).get(nombre);
}

export function leerIdCita(loc: { search: string; hash: string; pathname: string }): string | null {
  const hash = loc.hash.replace(/^#/, '');
  return (
    norm(leerParam(loc.search, 'id')) ??
    norm(new URLSearchParams(hash).get('id')) ??
    norm(hash) ??
    norm(/\/panel\/citas\/([^/]+)\/?$/.exec(loc.pathname)?.[1])
  );
}

export function leerToken(search: string): string | null {
  const t = leerParam(search, 't') ?? leerParam(search, 'token');
  return t && t.length <= 512 ? t : null;
}

export const rutaCita = (id: string) => `/panel/citas/?id=${encodeURIComponent(id)}`;
export const rutaVacante = (id: string) => `/panel/vacante/?id=${encodeURIComponent(id)}`;
