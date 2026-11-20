/**
 * Handler puro de comunicacion-worker. El cron de plataforma llama con
 * `Authorization: Bearer <secreto>` (COMUNICACION_WORKER_SECRET o SUPABASE_SERVICE_ROLE_KEY).
 */
import { timingSafeEqual } from '@shared/crypto.ts';
import { correlationId, json } from '@shared/http.ts';
import type { Logger } from '@shared/logger.ts';

export interface DepsHandlerWorker {
  secreto: string;
  log: Logger;
  correr: () => Promise<unknown>;
}

export function crearHandlerWorker(deps: DepsHandlerWorker): (req: Request) => Promise<Response> {
  return async (req) => {
    const log = deps.log.child({ correlation_id: correlationId(req) });
    if (req.method !== 'POST') return json({ error: 'METODO' }, 405, { allow: 'POST' });
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!deps.secreto || !timingSafeEqual(token, deps.secreto)) return json({ error: 'NO_AUTORIZADO' }, 401);
    try {
      const resumen = await deps.correr();
      log.info('comunicacion-worker ok', { resumen });
      return json({ ok: true, resumen });
    } catch (e) {
      log.error('comunicacion-worker falló', { error: (e as Error).name });
      return json({ ok: false, error: 'ERROR_INTERNO' }, 500);
    }
  };
}
