import { describe, expect, it } from 'vitest';
import {
  construirEventoMinimo,
  difiereDelEsperado,
  extraerUidPropio,
  nombrePilaSeguro,
  uidPropioDe,
  type EventoCalendario,
} from './evento.ts';
import type { EventoRemoto } from './tipos.ts';

const CITA = '0192f5a0-0000-7000-8000-000000000001';
const cfg = { panelUrl: 'https://panel.369.mx', zonaHoraria: 'America/Mexico_City' };
const datos = { citaId: CITA, folio: 'V-0042', nombrePila: 'María', inicio: '2026-11-16T16:00:00.000Z', fin: '2026-11-16T16:30:00.000Z' };

function construir(over: Partial<typeof datos> = {}): EventoCalendario {
  const r = construirEventoMinimo({ ...datos, ...over }, cfg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('evento mínimo (D9, NFR-SEG-04)', () => {
  it('título "Entrevista {folio} · {nombre de pila}", horario y link al panel', () => {
    const e = construir();
    expect(e.titulo).toBe('Entrevista V-0042 · María');
    expect(e.inicio).toBe('2026-11-16T16:00:00.000Z');
    expect(e.fin).toBe('2026-11-16T16:30:00.000Z');
    expect(e.zonaHoraria).toBe('America/Mexico_City');
    expect(e.descripcion).toContain(`https://panel.369.mx/panel/citas/?id=${CITA}`);
  });

  it('lleva un UID propio determinista en la descripción (idempotencia)', () => {
    const e = construir();
    expect(e.uidPropio).toBe(uidPropioDe(CITA));
    expect(construir().uidPropio).toBe(e.uidPropio);
    expect(extraerUidPropio(e.descripcion)).toBe(e.uidPropio);
  });

  it('no incluye asistentes ni recordatorios (Zoho no notifica)', () => {
    const e = construir();
    expect(e).not.toHaveProperty('asistentes');
    expect(e.recordatorios).toEqual([]);
  });

  it('solo usa el nombre de pila: descarta apellidos, dígitos y símbolos', () => {
    expect(nombrePilaSeguro('  maría josé  Pérez ')).toBe('María');
    expect(nombrePilaSeguro('Ana5512345678')).toBe('Ana');
    expect(nombrePilaSeguro('<script>')).toBe('Candidato');
    expect(nombrePilaSeguro('')).toBe('Candidato');
    expect(nombrePilaSeguro('a'.repeat(80))).toHaveLength(40);
  });

  it('rechaza un folio con posible teléfono (no se publica PII en Zoho)', () => {
    const r = construirEventoMinimo({ ...datos, folio: '5512345678' }, cfg);
    expect(r).toEqual({ ok: false, error: 'POSIBLE_PII' });
  });

  it('rechaza horarios inválidos o invertidos', () => {
    expect(construirEventoMinimo({ ...datos, inicio: 'mañana' }, cfg)).toEqual({ ok: false, error: 'DATOS_INVALIDOS' });
    expect(construirEventoMinimo({ ...datos, fin: datos.inicio }, cfg)).toEqual({ ok: false, error: 'DATOS_INVALIDOS' });
  });

  it('rechaza folios vacíos o con caracteres raros y cita_id no UUID', () => {
    expect(construirEventoMinimo({ ...datos, folio: '' }, cfg)).toEqual({ ok: false, error: 'DATOS_INVALIDOS' });
    expect(construirEventoMinimo({ ...datos, folio: 'V 1<b>' }, cfg)).toEqual({ ok: false, error: 'DATOS_INVALIDOS' });
    expect(construirEventoMinimo({ ...datos, citaId: '../x' }, cfg)).toEqual({ ok: false, error: 'DATOS_INVALIDOS' });
  });

  it('normaliza la URL del panel (sin doble diagonal)', () => {
    const r = construirEventoMinimo(datos, { ...cfg, panelUrl: 'https://panel.369.mx/' });
    expect(r.ok && r.value.descripcion).toContain(`https://panel.369.mx/panel/citas/?id=${CITA}`);
    expect(r.ok && r.value.descripcion).not.toContain('mx//panel');
  });

  it('extraerUidPropio devuelve null si no hay marcador', () => {
    expect(extraerUidPropio('evento creado a mano')).toBeNull();
    expect(extraerUidPropio(undefined)).toBeNull();
  });
});

describe('difiereDelEsperado', () => {
  const e = construir();
  const remoto: EventoRemoto = {
    uid: 'z1', etag: '1', titulo: e.titulo, descripcion: e.descripcion, inicio: e.inicio, fin: e.fin,
    uidPropio: e.uidPropio, numAsistentes: 0,
  };

  it('igual → no difiere (tolera milisegundos)', () => {
    expect(difiereDelEsperado(e, { ...remoto, inicio: '2026-11-16T16:00:00Z' })).toEqual([]);
  });

  it('detecta título, descripción, horario y asistentes agregados a mano', () => {
    expect(difiereDelEsperado(e, { ...remoto, titulo: 'Otro' })).toEqual(['titulo']);
    expect(difiereDelEsperado(e, { ...remoto, descripcion: 'x' })).toEqual(['descripcion']);
    expect(difiereDelEsperado(e, { ...remoto, inicio: '2026-11-16T17:00:00Z', fin: '2026-11-16T17:30:00Z' })).toEqual(['inicio', 'fin']);
    expect(difiereDelEsperado(e, { ...remoto, numAsistentes: 1 })).toEqual(['asistentes']);
  });
});

describe('normalizarCalendarUid (Z7)', () => {
  it('acepta uids de Zoho y rechaza vacíos, rutas o valores no texto', async () => {
    const { normalizarCalendarUid } = await import('./evento.ts');
    expect(normalizarCalendarUid('c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6')).toBe('c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6');
    expect(normalizarCalendarUid('  abc123@zoho.com ')).toBe('abc123@zoho.com');
    for (const v of [null, undefined, '', '   ', '../../admin', 'a b', 'x'.repeat(200), 42]) expect(normalizarCalendarUid(v)).toBeNull();
  });
});
