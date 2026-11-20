import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLimitadorMemoria } from './limitador.ts';

describe('limitador en memoria (ventana fija por llave)', () => {
  it('permite hasta max por ventana, luego indica cuándo reintentar y se reinicia', () => {
    const clock = new FixedClock(new Date('2026-11-17T00:00:00Z'));
    const l = crearLimitadorMemoria({ max: 2, ventanaMs: 60_000, clock });
    expect(l.permitir('ip1')).toEqual({ ok: true, reintentarEnSeg: 0 });
    expect(l.permitir('ip1').ok).toBe(true);
    clock.advance(15_000);
    expect(l.permitir('ip1')).toEqual({ ok: false, reintentarEnSeg: 45 });
    expect(l.permitir('ip2').ok).toBe(true);
    clock.advance(45_000);
    expect(l.permitir('ip1').ok).toBe(true);
  });

  it('acota la memoria: purga ventanas vencidas cuando crece', () => {
    const clock = new FixedClock(new Date('2026-11-17T00:00:00Z'));
    const l = crearLimitadorMemoria({ max: 1, ventanaMs: 1000, clock, maxLlaves: 10 });
    for (let i = 0; i < 10; i++) l.permitir(`k${i}`);
    clock.advance(2000);
    l.permitir('nueva');
    expect(l.tamano()).toBe(1);
    // si no hay vencidas y se llena, se descarta la más antigua
    for (let i = 0; i < 20; i++) l.permitir(`x${i}`);
    expect(l.tamano()).toBeLessThanOrEqual(10);
  });
});
