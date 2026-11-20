/**
 * NFR-OBS-01 · Corrida de alertas (cron cada 5 min): evaluar (SQL) → pendientes → notificar por cada canal
 * → marcar. Una alerta se da por notificada si AL MENOS un canal la entregó (reintentar duplicaría en los demás);
 * si todos fallan se marca el fallo y se reintenta en la siguiente corrida (máx. 5 intentos, en SQL).
 */
import type { Clock } from '@shared/clock.ts';
import type { Logger } from '@shared/logger.ts';
import type { Result } from '@shared/result.ts';
import { sanearDetalle, type Alerta } from '../domain/alertas.ts';

export interface RepoAlertasPort {
  evaluar(ahora: Date, config?: Record<string, number>): Promise<{ nuevas: number; tipos: string[] }>;
  pendientes(n: number): Promise<Alerta[]>;
  marcar(ids: string[], ok: boolean, detalle: string): Promise<void>;
}

/** Canal de notificación de alertas (webhook genérico, correo, …). El error es un código corto sin PII. */
export interface NotificadorAlertasPort {
  readonly canal: string;
  notificar(alertas: readonly Alerta[]): Promise<Result<void, string>>;
}

export interface DepsAlertas {
  repo: RepoAlertasPort;
  notificadores: readonly NotificadorAlertasPort[];
  clock: Clock;
  log: Logger;
  config?: Record<string, number>;
}

export interface ResumenAlertas {
  nuevas: number;
  tipos: string[];
  pendientes: number;
  notificadas: number;
  canales_ok: string[];
  canales_error: string[];
}

export async function ejecutarAlertas(d: DepsAlertas, lote = 50): Promise<ResumenAlertas> {
  const evaluacion = await d.repo.evaluar(d.clock.now(), d.config);
  const pendientes = await d.repo.pendientes(lote);
  const resumen: ResumenAlertas = { ...evaluacion, pendientes: pendientes.length, notificadas: 0, canales_ok: [], canales_error: [] };
  if (pendientes.length === 0) return resumen;

  for (const a of pendientes) {
    d.log[a.severidad === 'critica' ? 'error' : 'warn']('alerta', { metrica: 'alerta', tipo: a.tipo, severidad: a.severidad, clave: a.clave, detalle: sanearDetalle(a.detalle) });
  }
  if (d.notificadores.length === 0) {
    d.log.warn('alertas_sin_canal', { pendientes: pendientes.length, accion: 'configurar ALERTAS_WEBHOOK_URL o ALERTAS_EMAIL' });
    return resumen;
  }

  const errores: string[] = [];
  for (const n of d.notificadores) {
    let r: Result<void, string>;
    try {
      r = await n.notificar(pendientes);
    } catch {
      r = { ok: false, error: 'EXCEPCION' };
    }
    if (r.ok) resumen.canales_ok.push(n.canal);
    else {
      resumen.canales_error.push(n.canal);
      errores.push(`${n.canal}:${r.error}`);
      d.log.error('alertas: canal falló', { canal: n.canal, error: r.error });
    }
  }

  const ids = pendientes.map((a) => a.id);
  if (resumen.canales_ok.length > 0) {
    await d.repo.marcar(ids, true, resumen.canales_ok.join(','));
    resumen.notificadas = ids.length;
  } else {
    await d.repo.marcar(ids, false, errores.join('; '));
  }
  return resumen;
}
