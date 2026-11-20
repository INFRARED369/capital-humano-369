/**
 * Rate limit híbrido de tracking-ingest (NFR-SEG-03 sin romper NFR-ESC-01, 500 ev/s):
 *  1. Barrera local en memoria por isolate (por IP), síncrona.
 *  2. Contador agregado en BD por ventana (1 min) y red /24 (IPv6 /48), actualizado en LOTES: cada `loteEventos`
 *     eventos o cada `intervaloMs`, una sola consulta (`shared.rate_limit_sumar`). Si el total de todos los
 *     isolates supera `limiteGlobal`, la red queda bloqueada en este isolate el resto de la ventana.
 * `permitir` sigue siendo síncrono: el vaciado corre en segundo plano (`programar` = EdgeRuntime.waitUntil).
 * Si la BD falla, fail-open (la barrera local sigue protegiendo) y se registra en el log.
 */
import type { Clock } from '@shared/clock.ts';
import { hmacSha256Hex } from '@shared/crypto.ts';
import type { Logger } from '@shared/logger.ts';
import type { SqlClient } from '@shared/sql.ts';
import type { LimitadorPort } from '../../application/puertos.ts';
import { truncarIp } from '../../domain/ip.ts';

export interface ContadorGlobalPort {
  /** Suma los incrementos por red y devuelve el total de la ventana actual de cada una. */
  sumar(incrementos: ReadonlyMap<string, number>, ventanaSeg: number): Promise<Map<string, number>>;
}

export interface ConfigLimitadorHibrido {
  local: LimitadorPort;
  contador: ContadorGlobalPort;
  limiteGlobal: number;
  ventanaMs: number;
  loteEventos?: number;
  intervaloMs?: number;
  clock: Clock;
  log: Logger;
  programar?: (p: Promise<unknown>) => void;
}

export function crearLimitadorHibrido(cfg: ConfigLimitadorHibrido): LimitadorPort & { vaciar(): Promise<void> } {
  const lote = cfg.loteEventos ?? 50;
  const intervalo = cfg.intervaloMs ?? 5_000;
  const ventanaDe = (ms: number) => Math.floor(ms / cfg.ventanaMs);
  let pendientes = new Map<string, number>();
  let total = 0;
  let ultimoVaciado = cfg.clock.now().getTime();
  let vaciando: Promise<void> | null = null;
  let bloqueadas = new Map<string, number>(); // red → ventana en que se bloqueó

  async function vaciar(): Promise<void> {
    if (vaciando || total === 0) return vaciando ?? undefined;
    const lotePend = pendientes;
    pendientes = new Map();
    total = 0;
    ultimoVaciado = cfg.clock.now().getTime();
    const ventana = ventanaDe(ultimoVaciado);
    vaciando = (async () => {
      try {
        const totales = await cfg.contador.sumar(lotePend, Math.round(cfg.ventanaMs / 1000));
        for (const [red, n] of totales) if (n > cfg.limiteGlobal) bloqueadas.set(red, ventana);
      } catch (e) {
        cfg.log.warn('rate limit global no disponible (fail-open)', { error: (e as Error).name, metrica: 'tracking.rate_limit_global_error' });
      } finally {
        vaciando = null;
      }
    })();
    return vaciando;
  }

  return {
    permitir(ip) {
      if (!cfg.local.permitir(ip)) return false;
      const ahora = cfg.clock.now().getTime();
      const ventana = ventanaDe(ahora);
      if (bloqueadas.size > 0 && [...bloqueadas.values()].some((v) => v !== ventana)) {
        bloqueadas = new Map([...bloqueadas].filter(([, v]) => v === ventana));
      }
      const red = truncarIp(ip) ?? 'sin-ip';
      if (bloqueadas.get(red) === ventana) return false;
      pendientes.set(red, (pendientes.get(red) ?? 0) + 1);
      total++;
      if (total >= lote || ahora - ultimoVaciado >= intervalo) {
        const p = vaciar();
        if (cfg.programar) cfg.programar(p);
      }
      return true;
    },
    vaciar,
  };
}

/** Contador sobre shared.rate_limit (llave = HMAC de la red con HMAC_PEPPER: la tabla nunca ve la IP). */
export function crearContadorGlobalSql(sql: SqlClient, pepper: string): ContadorGlobalPort {
  return {
    async sumar(incrementos, ventanaSeg) {
      const redes = [...incrementos.keys()];
      const llaves = await Promise.all(redes.map(async (r) => `trk-ip:${(await hmacSha256Hex(pepper, `trk-ip|${r}`)).slice(0, 32)}`));
      const { rows } = await sql.query<{ llave: string; conteo: number }>(
        'select llave, conteo from shared.rate_limit_sumar($1::text[], $2::int[], $3)', [llaves, redes.map((r) => incrementos.get(r)!), ventanaSeg]);
      const porLlave = new Map(rows.map((f) => [f.llave, Number(f.conteo)]));
      return new Map(redes.map((r, i) => [r, porLlave.get(llaves[i]!) ?? 0]));
    },
  };
}
