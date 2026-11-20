/** Unitarias de application con un repo en memoria: caché de reglas (NFR-ESC-05), contrato y ramas. */
import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import type { EventoDominio } from '@shared/eventos.ts';
import type { AgendaPort } from '@domains/captacion/index.ts';
import { crearAgendaPort } from '../index.ts';
import { PLANTILLA_AGENDA_DEFECTO } from '../domain/reglas.ts';
import type { FilaReglas } from '../domain/reglas.ts';
import type { CitaRegistro, CitasRepo } from './puertos.ts';
import { confirmarCitaCaso, consultarCitaCaso, liberarRetencionCaso, obtenerSlotsCaso, reprogramarCitaCaso, retenerSlotCaso } from './casosDeUso.ts';
import { limpiarCacheReglas, reglasDeVacante, tamanoCacheReglas } from './reglasVigentes.ts';

const VAC = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const CITA = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const LEAD = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';

function repoFalso(o: { reglas?: FilaReglas | null; cita?: Partial<CitaRegistro> | null; modo?: 'sistema' | 'whatsapp' } = {}) {
  const llamadas = { reglas: 0, publicados: [] as EventoDominio[], cambios: [] as string[] };
  const cita: CitaRegistro | null =
    o.cita === null
      ? null
      : { id: CITA, clienteId: 'c', vacanteId: VAC, leadId: LEAD, inicio: '2026-11-17T16:00:00.000Z', fin: '2026-11-17T17:30:00.000Z', estado: 'retenida',
          reglasVersion: 1, expiraEn: '2026-11-17T02:10:00.000Z', motivo: null, ...o.cita };
  const repo: CitasRepo = {
    buscarVacante: async (ref) => (ref === VAC ? { id: VAC, clienteId: 'c', activa: true, agendaModo: o.modo ?? 'sistema' } : null),
    reglasVigentes: async () => { llamadas.reglas++; return o.reglas ?? null; },
    expirarRetenciones: async () => 0,
    ocupacion: async () => [],
    retener: async () => ({ resultado: 'CITA_ACTIVA' }),
    obtener: async () => cita,
    cambiarEstado: async (_id, c) => { llamadas.cambios.push(c.estado); },
    extenderRetencion: async () => {},
    publicar: async (e) => { llamadas.publicados.push(e); },
  };
  return { repo, llamadas };
}

const clock = () => new FixedClock(new Date('2026-11-17T02:00:00Z'));
beforeEach(() => limpiarCacheReglas());

describe('contrato con captación', () => {
  it('crearAgendaPort cumple AgendaPort de captación (verificado por el compilador)', () => {
    const p: AgendaPort = crearAgendaPort();
    expect(typeof p.retener).toBe('function');
  });
});

describe('NFR-ESC-05 · reglas cacheadas por versión', () => {
  it('valida una vez por (vacante, versión); una nueva versión entra a la caché', async () => {
    const fila = { version: 3, reglas: { agenda: { cupo_diario: 4 } } };
    const { repo } = repoFalso({ reglas: fila });
    const a = await reglasDeVacante(repo, VAC);
    const b = await reglasDeVacante(repo, VAC);
    expect(a.agenda).toBe(b.agenda); // misma instancia: no se re-parsea
    expect(tamanoCacheReglas()).toBe(1);
    fila.version = 4;
    expect((await reglasDeVacante(repo, VAC)).version).toBe(4);
    expect(tamanoCacheReglas()).toBe(2);
  });
  it('sin versión: plantilla y versión 0 (sin ocupar caché)', async () => {
    const { repo } = repoFalso();
    expect(await reglasDeVacante(repo, VAC)).toEqual({ version: 0, agenda: PLANTILLA_AGENDA_DEFECTO });
    expect(tamanoCacheReglas()).toBe(0);
  });
});

describe('ramas de casos de uso', () => {
  it('F7.4 · obtenerSlots expone el modo de agenda: whatsapp → sin slots del sistema; sistema → slots', async () => {
    const wa = await obtenerSlotsCaso(repoFalso({ modo: 'whatsapp' }).repo, clock(), VAC);
    expect(wa).toMatchObject({ ok: true, value: { vacanteId: VAC, agendaModo: 'whatsapp', slots: [] } });
    const sis = await obtenerSlotsCaso(repoFalso().repo, clock(), VAC);
    expect(sis.ok && sis.value.agendaModo).toBe('sistema');
    expect(sis.ok && sis.value.slots.length).toBeGreaterThan(0);
  });

  it('retenerSlot: vacante en modo whatsapp → SLOT_INVALIDO; CITA_ACTIVA → SLOT_INVALIDO; leadId inválido lanza', async () => {
    expect(await retenerSlotCaso(repoFalso({ modo: 'whatsapp' }).repo, { vacanteId: VAC, leadId: LEAD, inicio: '2026-11-17T16:00:00Z' }, clock())).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
    expect(await retenerSlotCaso(repoFalso().repo, { vacanteId: VAC, leadId: LEAD, inicio: '2026-11-17T16:00:00Z' }, clock())).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
    await expect(retenerSlotCaso(repoFalso().repo, { vacanteId: VAC, leadId: 'x', inicio: '2026-11-17T16:00:00Z' }, clock())).rejects.toThrow();
    expect(await retenerSlotCaso(repoFalso().repo, { vacanteId: VAC.replace('5b', '00'), leadId: LEAD, inicio: '2026-11-17T16:00:00Z' }, clock())).toEqual({ ok: false, error: 'VACANTE_NO_ENCONTRADA' });
  });

  it('confirmar: lead anonimizado → NO_ENCONTRADA; expirada por ttl → EXPIRADA sin escribir', async () => {
    expect(await confirmarCitaCaso(repoFalso({ cita: { leadId: null } }).repo, { citaId: CITA, folio: 'F', nombrePila: 'A', eventId: 'e' }, clock())).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    const { repo, llamadas } = repoFalso({ cita: { estado: 'expirada', motivo: 'ttl' } });
    expect(await confirmarCitaCaso(repo, { citaId: CITA, folio: 'F', nombrePila: 'A', eventId: 'e' }, clock())).toEqual({ ok: false, error: 'EXPIRADA' });
    expect(llamadas.cambios).toEqual([]);
  });

  it('liberar: inexistente o no retenida no escribe', async () => {
    const a = repoFalso({ cita: null });
    await liberarRetencionCaso(a.repo, { citaId: CITA, motivo: 'x' }, clock());
    const b = repoFalso({ cita: { estado: 'confirmada' } });
    await liberarRetencionCaso(b.repo, { citaId: CITA, motivo: 'x' }, clock());
    expect([...a.llamadas.cambios, ...b.llamadas.cambios]).toEqual([]);
  });

  it('reprogramar: la vacante dejó de aceptar (retener ≠ OK sin cupo) → SLOT_INVALIDO; no publica', async () => {
    const { repo, llamadas } = repoFalso({ cita: { estado: 'confirmada', expiraEn: null } });
    const r = await reprogramarCitaCaso(repo, { datosCita: async () => ({ folio: 'F', nombrePila: 'A' }) }, { citaId: CITA, nuevoInicio: '2026-11-18T16:00:00Z' }, clock());
    expect(r).toEqual({ ok: false, error: 'SLOT_INVALIDO' });
    expect(llamadas.publicados).toEqual([]);
  });

  it('consultar: id inválido, inexistente o anonimizada → NO_ENCONTRADA', async () => {
    expect(await consultarCitaCaso(repoFalso().repo, 'x')).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    expect(await consultarCitaCaso(repoFalso({ cita: null }).repo, CITA)).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    expect(await consultarCitaCaso(repoFalso({ cita: { leadId: null } }).repo, CITA)).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
  });

  it('obtenerSlots: vacante inexistente', async () => {
    expect(await obtenerSlotsCaso(repoFalso().repo, clock(), 'otra')).toEqual({ ok: false, error: 'VACANTE_NO_ENCONTRADA' });
  });
});
