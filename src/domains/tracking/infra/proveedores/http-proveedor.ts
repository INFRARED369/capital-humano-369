/** Utilidades comunes a los adaptadores HTTP de medición. */
import { err, ok, type Result } from '@shared/result.ts';
import type { ErrorEnvio } from '../../application/puertos.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const esReintentable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export async function postJson(fetchImpl: FetchLike, url: string, cuerpo: unknown, timeoutMs = 10_000): Promise<Result<Response, ErrorEnvio>> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return ok(res);
    return err({ reintentable: esReintentable(res.status), status: res.status, mensaje: `HTTP ${res.status}` });
  } catch (e) {
    return err({ reintentable: true, mensaje: `red: ${(e as Error).name}` });
  }
}
