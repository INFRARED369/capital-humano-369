/**
 * zoho-sync-worker (CIT-08, Z1–Z4, Z6, Z7, NFR-DISP-01).
 * 1) Ingiere el outbox (consumidor `zoho-sync`) → estado deseado + cola.
 * 2) Toma trabajos de la cola `zoho-sync` y sincroniza con Zoho.
 * Fallas: backoff y reintento (máx. 2), luego dead letter + alerta; un error permanente va directo a dead letter. Nunca toca la cita:
 * una caída de Zoho no afecta la reserva (la cita sigue confirmada).
 */
import { backoffSegundos, esReintentable, MAX_INTENTOS } from '../domain/reintento.ts';
import type { ErrorCalendario } from '../domain/tipos.ts';
import { ingerirOutbox } from './ingesta.ts';
import type { DepsWorker, TrabajoSync } from './puertos.ts';
import { sincronizarCita } from './sincronizar.ts';

export const COLA_ZOHO = 'zoho-sync';
export const CONSUMIDOR_ZOHO = 'zoho-sync';

export interface ResumenWorker {
  ingeridos: number;
  descartados: number;
  procesados: number;
  completados: number;
  reintentos: number;
  deadLetters: number;
}

export interface OpcionesWorker {
  lote?: number;
  /** Visibility timeout de la cola (s). */
  vtSeg?: number;
  /** Máximo de lotes de outbox por corrida. */
  maxLotesOutbox?: number;
}

const mensajeDe = (e: ErrorCalendario): string => `${e.tipo}${e.status ? ` ${e.status}` : ''}: ${e.mensaje}`.slice(0, 300);

async function manejarFalla(d: DepsWorker, t: TrabajoSync, e: ErrorCalendario): Promise<'reintento' | 'dead_letter'> {
  // Permanente (4xx distinto de 401/408/429, contrato roto, folio con PII) → dead letter inmediato.
  // auth espera el backoff máximo (puede corregirse rotando el token) y termina en dead letter tras MAX_INTENTOS.
  const msg = mensajeDe(e);
  const destino = e.tipo === 'permanente'
    ? await d.cola.fallarDefinitivo(t.id, msg)
    : await d.cola.fallar(t.id, msg, backoffSegundos(esReintentable(e) ? t.intentos : MAX_INTENTOS));
  await d.repo.marcarFalla(t.citaId, msg, destino === 'dead_letter');
  const reg = await d.repo.obtener(t.citaId);
  const contexto = { clienteId: reg?.clienteId ?? '', vacanteId: reg?.vacanteId ?? null, citaId: t.citaId };
  if (reg && e.tipo === 'auth') {
    await d.alertas.registrar({ ...contexto, tipo: 'ZOHO_AUTH', detalle: { status: e.status ?? null, accion: 'revisar refresh token / scope ZohoCalendar.event.ALL' } });
  }
  if (reg && destino === 'dead_letter') {
    await d.alertas.registrar({ ...contexto, tipo: 'ZOHO_DEAD_LETTER', detalle: { error: msg, intentos: t.intentos, trabajo: t.id } });
  }
  d.logger[destino === 'dead_letter' ? 'error' : 'warn']('zoho: falla al sincronizar', { cita_id: t.citaId, trabajo: t.id, intento: t.intentos, destino, error: msg });
  return destino;
}

export async function ejecutarWorkerZoho(d: DepsWorker, opts: OpcionesWorker = {}): Promise<ResumenWorker> {
  const lote = opts.lote ?? 20;
  const r: ResumenWorker = { ingeridos: 0, descartados: 0, procesados: 0, completados: 0, reintentos: 0, deadLetters: 0 };

  for (let i = 0; i < (opts.maxLotesOutbox ?? 5); i++) {
    const ing = await ingerirOutbox(d, 100);
    r.ingeridos += ing.ingeridos;
    r.descartados += ing.descartados;
    if (ing.ingeridos < 100) break;
  }

  await d.cola.recuperarVencidos();
  const trabajos = await d.cola.tomar(lote, opts.vtSeg ?? 120);
  for (const t of trabajos) {
    r.procesados++;
    let res;
    try {
      res = await sincronizarCita(d, t.citaId);
    } catch (e) {
      res = { ok: false as const, error: { tipo: 'transitorio' as const, mensaje: `excepción: ${(e as Error).name}` } };
    }
    if (res.ok) {
      await d.cola.completar(t.id);
      r.completados++;
      d.logger.info('zoho: sincronizado', { cita_id: t.citaId, resultado: res.value });
    } else if ((await manejarFalla(d, t, res.error)) === 'dead_letter') {
      r.deadLetters++;
    } else {
      r.reintentos++;
    }
  }
  return r;
}
