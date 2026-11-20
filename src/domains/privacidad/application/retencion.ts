/** PRV-01 · Cron diario `retencion-diaria`: un solo llamado al orquestador SQL (idempotente, en lotes). */
import type { DepsPrivacidad, ResumenRetencion } from './puertos.ts';

export async function ejecutarRetencionDiaria(deps: Pick<DepsPrivacidad, 'repo' | 'clock' | 'logger'>, maxLotes?: number): Promise<ResumenRetencion> {
  const r = await deps.repo.retencionDiaria(deps.clock.now(), maxLotes);
  if (r.omitida) {
    deps.logger.warn('retencion_omitida', { motivo: 'otra_corrida_en_curso' });
    return r;
  }
  // Solo conteos y nombres de reglas: el resumen nunca lleva datos personales (PRV-03).
  deps.logger.info('retencion_diaria', { registro_id: r.registroId, total: r.total, dominios: r.dominios, lotes: r.lotes, conteos: r.conteos });
  if (r.faltantes.length > 0 || Object.keys(r.errores).length > 0) {
    deps.logger.warn('retencion_incompleta', { faltantes: r.faltantes, errores: r.errores });
  }
  return r;
}
