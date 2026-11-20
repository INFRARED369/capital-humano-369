import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { crearLogger } from '@shared/logger.ts';
import { err, ok } from '@shared/result.ts';
import type { Alerta } from '../domain/alertas.ts';
import { ejecutarAlertas, type NotificadorAlertasPort, type RepoAlertasPort } from './ejecutar.ts';

const alerta = (id: string): Alerta => ({ id, tipo: 'cola_atascada', severidad: 'critica', clave: `k${id}`, creadaEn: '2026-11-17T18:00:00Z', detalle: { cola: 'comunicacion', atascados: 3 } });

function repoFalso(pendientes: Alerta[]) {
  const marcas: { ids: string[]; ok: boolean; detalle: string }[] = [];
  const evaluaciones: { ahora: string; config?: Record<string, number> }[] = [];
  const repo: RepoAlertasPort = {
    evaluar: async (ahora, config) => { evaluaciones.push({ ahora: ahora.toISOString(), config }); return { nuevas: pendientes.length, tipos: ['cola_atascada'] }; },
    pendientes: async (n) => pendientes.slice(0, n),
    marcar: async (ids, okk, detalle) => { marcas.push({ ids, ok: okk, detalle }); },
  };
  return { repo, marcas, evaluaciones };
}
const notificador = (canal: string, resultado: 'ok' | 'error' | 'lanza'): NotificadorAlertasPort & { recibidas: Alerta[][] } => {
  const recibidas: Alerta[][] = [];
  return {
    canal,
    recibidas,
    notificar: async (as) => {
      recibidas.push([...as]);
      if (resultado === 'lanza') throw new Error('boom ana@x.mx');
      return resultado === 'ok' ? ok(undefined) : err('HTTP_500');
    },
  };
};
const deps = (repo: RepoAlertasPort, notificadores: NotificadorAlertasPort[], logs: string[] = []) => ({
  repo, notificadores, clock: new FixedClock(new Date('2026-11-17T18:00:00Z')), log: crearLogger({}, (l) => logs.push(l)),
});

describe('ejecutarAlertas', () => {
  it('evalúa con el reloj y la config, notifica por todos los canales y marca notificadas con los canales que funcionaron', async () => {
    const { repo, marcas, evaluaciones } = repoFalso([alerta('1'), alerta('2')]);
    const web = notificador('webhook', 'ok');
    const mail = notificador('email', 'error');
    const r = await ejecutarAlertas({ ...deps(repo, [web, mail]), config: { cola_atascada_min: 10 } });
    expect(evaluaciones).toEqual([{ ahora: '2026-11-17T18:00:00.000Z', config: { cola_atascada_min: 10 } }]);
    expect(web.recibidas).toEqual([[alerta('1'), alerta('2')]]);
    expect(marcas).toEqual([{ ids: ['1', '2'], ok: true, detalle: 'webhook' }]);
    expect(r).toEqual({ nuevas: 2, tipos: ['cola_atascada'], pendientes: 2, notificadas: 2, canales_ok: ['webhook'], canales_error: ['email'] });
  });

  it('si todos los canales fallan (o lanzan) → marca el fallo para reintentar; sin PII en el log', async () => {
    const { repo, marcas } = repoFalso([alerta('1')]);
    const logs: string[] = [];
    const r = await ejecutarAlertas(deps(repo, [notificador('webhook', 'error'), notificador('email', 'lanza')], logs));
    expect(marcas).toEqual([{ ids: ['1'], ok: false, detalle: 'webhook:HTTP_500; email:EXCEPCION' }]);
    expect(r).toMatchObject({ notificadas: 0, canales_error: ['webhook', 'email'] });
    expect(logs.join('\n')).not.toContain('ana@x.mx');
  });

  it('sin pendientes no llama a los canales', async () => {
    const { repo, marcas } = repoFalso([]);
    const web = notificador('webhook', 'ok');
    expect(await ejecutarAlertas(deps(repo, [web]))).toMatchObject({ pendientes: 0, notificadas: 0 });
    expect(web.recibidas).toEqual([]);
    expect(marcas).toEqual([]);
  });

  it('sin canales configurados: no marca (quedan pendientes en shared.alertas) y avisa en el log con cada alerta', async () => {
    const { repo, marcas } = repoFalso([alerta('1')]);
    const logs: string[] = [];
    expect(await ejecutarAlertas(deps(repo, [], logs))).toMatchObject({ pendientes: 1, notificadas: 0, canales_ok: [] });
    expect(marcas).toEqual([]);
    expect(logs.some((l) => l.includes('alertas_sin_canal'))).toBe(true);
    expect(logs.some((l) => l.includes('"metrica":"alerta"') && l.includes('cola_atascada'))).toBe(true);
  });
});
