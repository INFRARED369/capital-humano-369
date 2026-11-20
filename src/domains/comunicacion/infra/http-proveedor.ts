/** Utilidades comunes a los adaptadores HTTP de proveedores de mensajería. */
import type { ErrorEnvio } from '../application/puertos.ts';

export const TIMEOUT_MS = 10_000;

/** 4xx (salvo 408/429) = permanente; 5xx, 408, 429 = transitorio. */
export const errorHttp = (status: number): ErrorEnvio => ({ motivo: `HTTP_${status}`, permanente: status >= 400 && status < 500 && status !== 408 && status !== 429 });

/**
 * Fragmento legible de la respuesta de error del proveedor, sin datos personales: se quitan correos,
 * secuencias de 7+ dígitos (teléfonos), JIDs y lo que parezca token. Máx. 140 caracteres.
 */
export function detalleSeguro(cuerpo: string): string {
  return cuerpo
    .replace(/[A-Za-z0-9_=+/-]{24,}/g, '…')
    .replace(/[\w.+-]+@[\w.-]+/g, '')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '#')
    .replace(/[{}"[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/** Como `errorHttp`, pero agrega el porqué que manda el proveedor (p. ej. "HTTP_403: IP no autorizada"). */
export async function errorHttpConDetalle(r: Response): Promise<ErrorEnvio> {
  const base = errorHttp(r.status);
  let texto = '';
  try {
    texto = detalleSeguro(await r.text());
  } catch {
    /* sin cuerpo */
  }
  return texto ? { ...base, motivo: `${base.motivo}: ${texto}` } : base;
}

export async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Response | null> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null; // red / timeout; el mensaje del error puede contener el destino: no se propaga
  }
}

export async function leerJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

export function exigirHttps(url: string, nombre: string): string {
  if (!/^https:\/\//.test(url)) throw new Error(`${nombre}: la URL debe ser https`);
  return url.replace(/\/+$/, '');
}
