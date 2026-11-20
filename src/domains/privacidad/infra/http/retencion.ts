/**
 * Handler puro de `retencion-diaria` (PRV-01). Lo invoca pg_cron (plataforma) con
 * `Authorization: Bearer <RETENCION_SECRET | SUPABASE_SERVICE_ROLE_KEY>`.
 */
import { timingSafeEqual } from '@shared/crypto.ts';
import { correlationId, json } from '@shared/http.ts';
import type { Logger } from '@shared/logger.ts';
import type { ResumenRetencion } from '../../application/puertos.ts';

export interface DepsHandlerRetencion {
  secreto: string;
  log: Logger;
  ejecutar: () => Promise<ResumenRetencion>;
}

export function crearHandlerRetencion(deps: DepsHandlerRetencion): (req: Request) => Promise<Response> {
  return async (req) => {
    const log = deps.log.child({ correlation_id: correlationId(req) });
    if (req.method !== 'POST') return json({ error: 'METODO' }, 405, { allow: 'POST' });
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!deps.secreto || !token || !timingSafeEqual(token, deps.secreto)) {
      log.warn('retencion_no_autorizada');
      return json({ error: 'NO_AUTORIZADO' }, 401);
    }
    try {
      const r = await deps.ejecutar();
      return json({ ok: true, omitida: r.omitida, registro_id: r.registroId, total: r.total, faltantes: r.faltantes, errores: r.errores, conteos: r.conteos });
    } catch (e) {
      log.error('retencion_fallo', { error: (e as Error).name });
      return json({ ok: false, error: 'ERROR_INTERNO' }, 500);
    }
  };
}
