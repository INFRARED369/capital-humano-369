/**
 * Una corrida del comunicacion-worker (cron cada minuto): recupera vencidos → outbox de citas → lote de envíos.
 * NFR-OBS-01: deja métricas (dead letters, reintentos, pospuestos) en el log estructurado.
 */
import type { SqlClient } from '@shared/sql.ts';
import { procesarEventosCitas, type DepsSuscriptores, type ResumenSuscriptores } from './suscriptores.ts';
import { procesarLote, type DepsWorker, type ResumenLote } from './worker.ts';

export interface DepsTrabajo extends DepsWorker {
  reglasEn: DepsSuscriptores['reglasEn'];
  links: DepsSuscriptores['links'];
  loteOutbox?: number;
  loteEnvios?: number;
}

export interface ResumenTrabajo {
  recuperados: number;
  outbox: ResumenSuscriptores;
  envios: ResumenLote;
}

const recuperarVencidos = async (sql: SqlClient) => (await sql.query<{ n: number }>(`select shared.recuperar_vencidos() as n`)).rows[0]!.n;

export async function correrTrabajoComunicacion(deps: DepsTrabajo): Promise<ResumenTrabajo> {
  const recuperados = await recuperarVencidos(deps.sql);
  const outbox = await procesarEventosCitas(deps, deps.loteOutbox ?? 100);
  const envios = await procesarLote(deps, { n: deps.loteEnvios ?? 25 });
  if (envios.dead_letter) deps.logger.error('dead letters en comunicacion', { metrica: 'comunicacion.dead_letter_total', valor: envios.dead_letter });
  return { recuperados, outbox, envios };
}
