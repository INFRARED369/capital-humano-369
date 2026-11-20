/** Rate limit en memoria por instancia (ventana fija). Suficiente contra ráfagas; ver bitácora (pendiente distribuido). */
import type { Clock } from '@shared/clock.ts';
import type { LimitadorPort } from '../../application/puertos.ts';

export function crearLimitadorMemoria(cfg: { max: number; ventanaMs: number; maxLlaves?: number }, clock: Clock): LimitadorPort {
  const cubetas = new Map<string, { inicio: number; n: number }>();
  return {
    permitir(llave) {
      const ahora = clock.now().getTime();
      if (cubetas.size > (cfg.maxLlaves ?? 50_000)) {
        for (const [k, c] of cubetas) if (ahora - c.inicio >= cfg.ventanaMs) cubetas.delete(k);
      }
      const c = cubetas.get(llave);
      if (!c || ahora - c.inicio >= cfg.ventanaMs) {
        cubetas.set(llave, { inicio: ahora, n: 1 });
        return true;
      }
      c.n++;
      return c.n <= cfg.max;
    },
  };
}
