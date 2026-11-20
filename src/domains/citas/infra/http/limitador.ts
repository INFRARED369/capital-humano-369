/**
 * Rate limit simple por llave (IP) con ventana fija, en memoria de la instancia de la edge function.
 * Limitación conocida: no es global entre instancias; es una primera barrera (la de fondo es Cloudflare/WAF).
 */
import { systemClock, type Clock } from '@shared/clock.ts';

export interface DecisionLimite { ok: boolean; reintentarEnSeg: number }

/** Puerto: en producción se cablea al rate limit en BD de plataforma (global, llaves HMAC). */
export interface Limitador {
  permitir(llave: string): DecisionLimite | Promise<DecisionLimite>;
}

export function crearLimitadorMemoria(o: { max: number; ventanaMs: number; clock?: Clock; maxLlaves?: number }): { permitir(llave: string): DecisionLimite; tamano(): number } {
  const clock = o.clock ?? systemClock;
  const maxLlaves = o.maxLlaves ?? 10_000;
  const ventanas = new Map<string, { desde: number; n: number }>();

  const purgar = (ahora: number) => {
    for (const [k, v] of ventanas) if (ahora - v.desde >= o.ventanaMs) ventanas.delete(k);
    while (ventanas.size >= maxLlaves) ventanas.delete(ventanas.keys().next().value as string);
  };

  return {
    permitir(llave) {
      const ahora = clock.now().getTime();
      let v = ventanas.get(llave);
      if (!v || ahora - v.desde >= o.ventanaMs) {
        if (!v && ventanas.size >= maxLlaves) purgar(ahora);
        v = { desde: ahora, n: 0 };
        ventanas.set(llave, v);
      }
      if (v.n >= o.max) return { ok: false, reintentarEnSeg: Math.max(1, Math.ceil((v.desde + o.ventanaMs - ahora) / 1000)) };
      v.n++;
      return { ok: true, reintentarEnSeg: 0 };
    },
    tamano: () => ventanas.size,
  };
}
