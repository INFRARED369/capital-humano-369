import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { crearLimitadorHibrido, type ContadorGlobalPort } from './limitador-hibrido.ts';
import { crearLimitadorMemoria } from './limitador.ts';

function contadorFalso(otrosIsolates: Record<string, number> = {}) {
  const totales = new Map<string, number>(Object.entries(otrosIsolates));
  const llamadas: Record<string, number>[] = [];
  let fallar = false;
  const c: ContadorGlobalPort = {
    async sumar(inc) {
      if (fallar) throw new Error('db caída');
      llamadas.push(Object.fromEntries(inc));
      for (const [k, v] of inc) totales.set(k, (totales.get(k) ?? 0) + v);
      return new Map([...inc.keys()].map((k) => [k, totales.get(k)!]));
    },
  };
  return { c, llamadas, totales, fallar: (v: boolean) => { fallar = v; } };
}

const reloj = () => new FixedClock(new Date('2026-11-17T18:00:10Z'));
const crear = (clock: FixedClock, contador: ContadorGlobalPort, o: { local?: number; global?: number; lote?: number } = {}) => {
  const pendientes: Promise<unknown>[] = [];
  const l = crearLimitadorHibrido({
    local: crearLimitadorMemoria({ max: o.local ?? 1000, ventanaMs: 60_000 }, clock),
    contador, limiteGlobal: o.global ?? 100, ventanaMs: 60_000, loteEventos: o.lote ?? 10, intervaloMs: 5_000, clock,
    log: crearLogger({}, () => {}), programar: (p) => { pendientes.push(p); },
  });
  return { l, esperar: () => Promise.all(pendientes.splice(0)) };
};

describe('limitador híbrido de tracking-ingest (memoria + contador agregado en BD por lotes y /24)', () => {
  it('NO consulta la BD por evento: una suma cada N eventos, agregada por red /24', async () => {
    const clock = reloj();
    const { c, llamadas } = contadorFalso();
    const { l, esperar } = crear(clock, c, { lote: 10 });
    for (let i = 0; i < 9; i++) expect(l.permitir(`189.203.1.${i}`)).toBe(true);
    expect(llamadas).toHaveLength(0);
    l.permitir('8.8.8.8');
    await esperar();
    expect(llamadas).toEqual([{ '189.203.1.0': 9, '8.8.8.0': 1 }]);
  });

  it('también vacía por tiempo (cada X s) aunque no se llegue al lote', async () => {
    const clock = reloj();
    const { c, llamadas } = contadorFalso();
    const { l, esperar } = crear(clock, c, { lote: 1000 });
    l.permitir('1.2.3.4');
    clock.advance(5_001);
    l.permitir('1.2.3.5');
    await esperar();
    expect(llamadas).toEqual([{ '1.2.3.0': 2 }]);
  });

  it('si el total agregado de la /24 (todos los isolates) supera el límite → bloquea esa red el resto de la ventana', async () => {
    const clock = reloj();
    const { c } = contadorFalso({ '189.203.1.0': 95 }); // otros isolates ya contaron 95
    const { l, esperar } = crear(clock, c, { global: 100, lote: 10 });
    for (let i = 0; i < 10; i++) l.permitir('189.203.1.9');
    await esperar();
    expect(l.permitir('189.203.1.200')).toBe(false); // misma /24
    expect(l.permitir('189.203.2.1')).toBe(true);    // otra red
    clock.advance(60_000);                           // ventana nueva
    expect(l.permitir('189.203.1.9')).toBe(true);
  });

  it('la barrera local en memoria corta primero, sin esperar a la BD', () => {
    const { c } = contadorFalso();
    const { l } = crear(reloj(), c, { local: 2 });
    expect([l.permitir('5.5.5.5'), l.permitir('5.5.5.5'), l.permitir('5.5.5.5')]).toEqual([true, true, false]);
  });

  it('BD caída → fail-open (la barrera local sigue protegiendo) y no se pierden los conteos siguientes', async () => {
    const clock = reloj();
    const k = contadorFalso();
    const { l, esperar } = crear(clock, k.c, { lote: 2 });
    k.fallar(true);
    l.permitir('1.1.1.1');
    l.permitir('1.1.1.2');
    await esperar();
    expect(l.permitir('1.1.1.3')).toBe(true);
    k.fallar(false);
    l.permitir('1.1.1.4');
    await esperar();
    expect(k.llamadas).toEqual([{ '1.1.1.0': 2 }]);
  });

  it('IP ausente o inválida cuenta como "sin-ip"', async () => {
    const { c, llamadas } = contadorFalso();
    const { l, esperar } = crear(reloj(), c, { lote: 1 });
    l.permitir('sin-ip');
    await esperar();
    expect(llamadas).toEqual([{ 'sin-ip': 1 }]);
  });
});
