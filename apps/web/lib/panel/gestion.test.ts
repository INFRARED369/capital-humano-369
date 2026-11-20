import { describe, expect, it, vi } from 'vitest';
import { agruparSlots, crearClienteGestion, interpretarConsulta, mensajeGestion, tomarToken } from './gestion';

const CITA = { cita_id: 'c1', vacante_id: 'v1', estado: 'confirmada', inicio_utc: '2026-11-18T16:00:00.000Z', fin_utc: '2026-11-18T17:30:00.000Z', inicio_local: '2026-11-18T10:00:00-06:00', zona_horaria: 'America/Mexico_City' };

describe('/cita/gestionar (CIT-11, C15, E2E-10)', () => {
  it('cliente: POST a gestionar-cita con { token, operacion, nuevo_inicio? }', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ accion: 'cancelar', cita: CITA }), { status: 200 }));
    const c = crearClienteGestion('https://p.supabase.co/functions/v1', f);
    expect(await c.consultar('tok')).toEqual({ tipo: 'ok', status: 200, cuerpo: { accion: 'cancelar', cita: CITA } });
    await c.ejecutar('tok', '2026-11-18T16:30:00.000Z');
    const cuerpos = f.mock.calls.map((x) => JSON.parse(String((x as unknown as [string, RequestInit])[1].body)));
    expect(cuerpos).toEqual([{ token: 'tok', operacion: 'consultar' }, { token: 'tok', operacion: 'ejecutar', nuevo_inicio: '2026-11-18T16:30:00.000Z' }]);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://p.supabase.co/functions/v1/gestionar-cita');

    const err = crearClienteGestion('https://p', async () => new Response(JSON.stringify({ error: 'TOKEN_VENCIDO' }), { status: 401 }));
    expect(await err.consultar('t')).toEqual({ tipo: 'error', status: 401, codigo: 'TOKEN_VENCIDO' });
    const red = crearClienteGestion('https://p', async () => { throw new Error('x'); });
    expect(await red.consultar('t')).toEqual({ tipo: 'error', status: 0, codigo: 'RED' });
  });

  it('401: link vencido o alterado con mensajes claros; 409 y otros', () => {
    expect(mensajeGestion('TOKEN_VENCIDO').titulo).toMatch(/venci/i);
    expect(mensajeGestion('TOKEN_INVALIDO').titulo).toMatch(/no es válido/i);
    expect(mensajeGestion('TRANSICION_INVALIDA').mensaje).toMatch(/ya fue/i);
    expect(mensajeGestion('SLOT_LLENO').mensaje).toMatch(/otro horario/i);
    expect(mensajeGestion('RED').mensaje).toMatch(/WhatsApp/i);
    expect(mensajeGestion('???').titulo.length).toBeGreaterThan(3);
  });

  it('interpreta la consulta y descarta respuestas fuera de contrato', () => {
    const r = interpretarConsulta({ accion: 'reprogramar', cita: CITA, slots: [{ inicio_utc: '2026-11-18T16:30:00.000Z', fin_utc: 'x', inicio_local: 'x', fecha: '2026-11-18', hora_local: '10:30', disponibles: 1 }] });
    expect(r?.accion).toBe('reprogramar');
    expect(r?.slots).toHaveLength(1);
    expect(interpretarConsulta({ accion: 'borrar', cita: CITA })).toBeNull();
    expect(interpretarConsulta({ accion: 'cancelar', cita: CITA })?.slots).toEqual([]);
  });

  it('tomarToken: lee ?t=, lo guarda en la pestaña y lo quita de la URL (no llega a Pixel/Clarity ni al Referer)', () => {
    const almacen = new Map<string, string>();
    const storage = { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => void almacen.set(k, v) };
    const replaceState = vi.fn();
    const win = { location: { pathname: '/cita/gestionar/', search: '?t=abc.def', hash: '' }, history: { state: null, replaceState }, sessionStorage: storage };
    expect(tomarToken(win)).toBe('abc.def');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/cita/gestionar/');
    // recarga sin query: lo recupera de la pestaña
    expect(tomarToken({ ...win, location: { ...win.location, search: '' } })).toBe('abc.def');
    // sin token ni almacenamiento (o storage bloqueado) → null
    expect(tomarToken({ ...win, location: { ...win.location, search: '' }, sessionStorage: { getItem: () => { throw new Error('bloqueado'); }, setItem: () => {} } })).toBeNull();
  });

  it('agrupa slots por fecha con etiqueta legible', () => {
    const g = agruparSlots([
      { inicio_utc: 'a', fecha: '2026-11-18', hora_local: '10:00' },
      { inicio_utc: 'b', fecha: '2026-11-18', hora_local: '10:30' },
      { inicio_utc: 'c', fecha: '2026-11-19', hora_local: '09:30' },
    ]);
    expect(g.map((d) => [d.fecha, d.slots.length])).toEqual([['2026-11-18', 2], ['2026-11-19', 1]]);
    expect(g[0]!.etiqueta).toMatch(/18/);
  });
});
