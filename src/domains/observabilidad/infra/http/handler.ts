/** Handler puro de la edge function `alertas` (cron cada 5 min, Bearer = service key). */
import { json } from '@shared/http.ts';
import { timingSafeEqual } from '@shared/crypto.ts';
import type { Logger } from '@shared/logger.ts';

export function crearHandlerAlertas(deps: { secreto: string; correr: () => Promise<object>; log: Logger }) {
  if (deps.secreto.length < 16) throw new Error('secreto de alertas demasiado corto');
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'METODO' }, 405, { allow: 'POST' });
    if (!timingSafeEqual(req.headers.get('authorization') ?? '', `Bearer ${deps.secreto}`)) return json({ error: 'NO_AUTORIZADO' }, 401);
    try {
      return json({ ok: true, ...(await deps.correr()) });
    } catch (e) {
      deps.log.error('alertas: error', { error: (e as Error).name });
      return json({ error: 'INTERNO' }, 500);
    }
  };
}
