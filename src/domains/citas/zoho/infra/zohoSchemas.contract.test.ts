/**
 * Prueba de contrato (Zod + fixtures grabados) de la API de eventos de Zoho Calendar v1.
 * Si Zoho cambia la forma de sus respuestas, el smoke nightly regraba los fixtures y esta prueba lo detecta.
 */
import { describe, expect, it } from 'vitest';
import { construirEventoMinimo } from '../domain/evento.ts';
import {
  EventDataSalidaSchema,
  ZohoErrorSchema,
  ZohoEventosRespuestaSchema,
  ZohoTokenRespuestaSchema,
  aEventDataZoho,
  aEventoRemoto,
  deFechaZoho,
  aFechaZoho,
  aRangoZoho,
} from './zohoSchemas.ts';
import creado from './__fixtures__/evento-creado.json';
import actualizado from './__fixtures__/evento-actualizado.json';
import lista from './__fixtures__/eventos-lista.json';
import vacia from './__fixtures__/eventos-lista-vacia.json';
import tokenOk from './__fixtures__/token-ok.json';
import tokenError from './__fixtures__/token-error.json';
import errTokenInvalido from './__fixtures__/error-token-invalido.json';
import errNoEncontrado from './__fixtures__/error-evento-no-encontrado.json';
import errInterno from './__fixtures__/error-interno.json';

const CITA = '0192f5a0-0000-7000-8000-000000000001';

describe('contrato · respuestas de eventos', () => {
  it.each([['creado', creado], ['actualizado', actualizado], ['lista', lista], ['vacía', vacia]])('fixture %s cumple el esquema', (_n, f) => {
    expect(ZohoEventosRespuestaSchema.safeParse(f).success).toBe(true);
  });

  it('mapea un evento de Zoho a EventoRemoto (fechas con offset → ISO UTC, etag string, UID propio)', () => {
    const r = ZohoEventosRespuestaSchema.parse(creado);
    expect(aEventoRemoto(r.events[0]!)).toEqual({
      uid: '8b1c2f0e4a6d4e2b9a3c7d5e1f0a2b3c@zoho.com',
      etag: '1763308800123',
      titulo: 'Entrevista V-0042 · María',
      descripcion: expect.stringContaining('/panel/citas/'),
      inicio: '2026-11-16T16:00:00.000Z',
      fin: '2026-11-16T16:30:00.000Z',
      uidPropio: `cita-${CITA}`,
      numAsistentes: 0,
    });
  });

  it('eventos ajenos: sin descripción → uidPropio null; cuenta asistentes', () => {
    const r = ZohoEventosRespuestaSchema.parse(lista);
    const ajeno = aEventoRemoto(r.events[1]!);
    expect(ajeno.uidPropio).toBeNull();
    expect(ajeno.numAsistentes).toBe(1);
    expect(ajeno.descripcion).toBe('');
  });

  it('rechaza una respuesta sin uid o sin dateandtime', () => {
    expect(ZohoEventosRespuestaSchema.safeParse({ events: [{ title: 'x' }] }).success).toBe(false);
  });
});

describe('contrato · OAuth y errores', () => {
  it('token ok y token con error', () => {
    const ok = ZohoTokenRespuestaSchema.parse(tokenOk);
    expect('access_token' in ok && ok.expires_in).toBe(3600);
    const e = ZohoTokenRespuestaSchema.parse(tokenError);
    expect('error' in e && e.error).toBe('invalid_code');
  });

  it.each([errTokenInvalido, errNoEncontrado, errInterno])('errores de la API se reconocen', (f) => {
    expect(ZohoErrorSchema.safeParse(f).success).toBe(true);
  });
});

describe('contrato · eventdata de salida (D9)', () => {
  const r = construirEventoMinimo({ citaId: CITA, folio: 'V-0042', nombrePila: 'María', inicio: '2026-11-16T16:00:00.000Z', fin: '2026-11-16T16:30:00.000Z' }, { panelUrl: 'https://panel.369.mx', zonaHoraria: 'America/Mexico_City' });
  if (!r.ok) throw new Error(r.error);

  it('formato Zoho: dateandtime en UTC compacto, sin asistentes ni recordatorios', () => {
    const data = aEventDataZoho(r.value);
    expect(data).toEqual({
      title: 'Entrevista V-0042 · María',
      description: r.value.descripcion,
      dateandtime: { timezone: 'America/Mexico_City', start: '20261116T160000Z', end: '20261116T163000Z' },
      isallday: false,
    });
    expect(EventDataSalidaSchema.safeParse(data).success).toBe(true);
    // Zoho rechaza reminders: [] (400 ARRAY_SIZE_OUT_OF_RANGE, acepta 1–4): el campo no se envía.
    expect(EventDataSalidaSchema.safeParse({ ...data, reminders: [] }).success).toBe(false);
  });

  it('con etag (actualización) lo incluye; el esquema estricto rechaza attendees', () => {
    expect(aEventDataZoho(r.value, '55').etag).toBe(55);
    expect(EventDataSalidaSchema.safeParse({ ...aEventDataZoho(r.value), attendees: [{ email: 'x@y.z' }] }).success).toBe(false);
  });

  it('fechas: ida y vuelta, offsets, rango por día', () => {
    expect(aFechaZoho('2026-11-16T16:00:00.000Z')).toBe('20261116T160000Z');
    expect(deFechaZoho('20261116T100000-0600')).toBe('2026-11-16T16:00:00.000Z');
    expect(deFechaZoho('20261116T213000+0530')).toBe('2026-11-16T16:00:00.000Z');
    expect(deFechaZoho('20261116')).toBe('2026-11-16T00:00:00.000Z');
    expect(() => deFechaZoho('ayer')).toThrow();
    expect(aRangoZoho('2026-11-16T16:00:00.000Z', '2026-11-20T01:00:00.000Z')).toEqual({ start: '20261116', end: '20261120' });
  });
});
