import { describe, expect, it } from 'vitest';
import { PLANTILLA_AGENDA_DEFECTO, ReglasAgendaSchema } from '@domains/citas/index.ts';
import { ReglasMensajesSchema } from '@domains/comunicacion/index.ts';
import { PLANTILLA_VACANTE_DEFECTO, ReglasVacanteSchema, advertenciasReglas, normalizarReglas, type ReglasVacante } from './reglas.ts';

const clonar = (r: ReglasVacante): ReglasVacante => JSON.parse(JSON.stringify(r)) as ReglasVacante;

describe('ReglasVacanteSchema (D7, DSH-04): compone agenda (citas) + mensajes (comunicacion)', () => {
  it('la plantilla por defecto es el valor inicial: agenda y mensajes por defecto, sin calendario de Zoho', () => {
    expect(PLANTILLA_VACANTE_DEFECTO.agenda).toEqual(PLANTILLA_AGENDA_DEFECTO);
    expect(PLANTILLA_VACANTE_DEFECTO.mensajes).toEqual(ReglasMensajesSchema.parse({}));
    expect(PLANTILLA_VACANTE_DEFECTO.zoho_calendar_uid).toBeUndefined();
    expect(ReglasVacanteSchema.parse({})).toEqual(PLANTILLA_VACANTE_DEFECTO);
    expect(Object.isFrozen(PLANTILLA_VACANTE_DEFECTO)).toBe(true);
  });

  it('la ventana de contacto vive en mensajes.ventana_contacto (por defecto 08:00–21:00 CDMX)', () => {
    expect(PLANTILLA_VACANTE_DEFECTO.mensajes.ventana_contacto).toEqual({ zona_horaria: 'America/Mexico_City', inicio: '08:00', fin: '21:00', dias: [0, 1, 2, 3, 4, 5, 6] });
  });

  it('acepta reglas parciales y completa el resto con la plantilla (E2E-08: cupo 5, sin tarde)', () => {
    const r = ReglasVacanteSchema.parse({ agenda: { cupo_diario: 5, ventanas_inicio: [{ desde: '09:30', hasta: '13:00' }] } });
    expect(r.agenda.cupo_diario).toBe(5);
    expect(r.agenda.ventanas_inicio).toHaveLength(1);
    expect(r.agenda.intervalo_min).toBe(30);
    expect(r.mensajes.canal_preferido).toBe('email');
  });

  it('el bloque agenda es exactamente el esquema de citas (misma salida)', () => {
    const agenda = { intervalo_min: 60, capacidad_por_slot: 3, ventanas_inicio: [{ desde: '08:00', hasta: '12:00' }] };
    expect(ReglasVacanteSchema.parse({ agenda }).agenda).toEqual(ReglasAgendaSchema.parse(agenda));
  });

  it('normaliza y valida el uid del calendario de Zoho', () => {
    expect(ReglasVacanteSchema.parse({ zoho_calendar_uid: '  abc123@zoho.com ' }).zoho_calendar_uid).toBe('abc123@zoho.com');
    for (const v of ['', '../../admin', 'a b', 'x'.repeat(200)]) expect(ReglasVacanteSchema.safeParse({ zoho_calendar_uid: v }).success).toBe(false);
  });

  it('es estricto en la raíz (campos desconocidos se rechazan)', () => {
    expect(ReglasVacanteSchema.safeParse({ agenda: {}, otra_cosa: 1 }).success).toBe(false);
  });

  it.each([
    ['agenda inválida', { agenda: { cupo_diario: 0 } }],
    ['zona inválida', { agenda: { zona_horaria: 'Marte/Olimpo' } }],
    ['plantilla con variable desconocida', { mensajes: { plantillas: { confirmacion: { texto: 'Hola {{telefono}}' } } } }],
    ['ventana de contacto invertida', { mensajes: { ventana_contacto: { inicio: '21:00', fin: '08:00' } } }],
    ['no es objeto', 'hola'],
  ])('rechaza %s', (_n, entrada) => {
    expect(ReglasVacanteSchema.safeParse(entrada).success).toBe(false);
  });
});

describe('normalizarReglas: Result con problemas por ruta (para el editor y el 422)', () => {
  it('ok → reglas completas', () => {
    const r = normalizarReglas({ agenda: { cupo_diario: 7 } });
    expect(r.ok && r.value.agenda.cupo_diario).toBe(7);
  });

  it('error → lista de { ruta, mensaje } sin eco del valor recibido', () => {
    const r = normalizarReglas({ agenda: { cupo_diario: 0, intervalo_min: 'x' } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.map((p) => p.ruta).sort()).toEqual(['agenda.cupo_diario', 'agenda.intervalo_min']);
    for (const p of r.error) expect(p.mensaje.length).toBeGreaterThan(0);
  });

  it('error en la raíz usa la ruta vacía', () => {
    const r = normalizarReglas(null);
    expect(!r.ok && r.error[0]!.ruta).toBe('');
  });

  it('rechaza reglas que exceden 64 KB', () => {
    const festivos = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10));
    const bloqueos = Array.from({ length: 500 }, (_, i) => ({ desde: `2027-01-01T0${i % 10}:00:00Z`, hasta: `2027-01-01T0${i % 10}:30:00Z`, motivo: 'x'.repeat(120) }));
    const r = normalizarReglas({ agenda: { festivos, bloqueos } });
    expect(!r.ok && r.error[0]!.mensaje).toMatch(/64 KB/);
  });
});

describe('advertenciasReglas: avisos no bloqueantes para el editor', () => {
  it('la plantilla solo avisa que falta el calendario de Zoho (Z7)', () => {
    expect(advertenciasReglas(PLANTILLA_VACANTE_DEFECTO).map((a) => a.codigo)).toEqual(['SIN_CALENDARIO_ZOHO']);
  });

  it('avisa zona distinta, capacidad > cupo, recordatorios invertidos y retención mayor que la antelación', () => {
    const r = clonar(PLANTILLA_VACANTE_DEFECTO);
    r.zoho_calendar_uid = 'calendario-123';
    r.mensajes.ventana_contacto.zona_horaria = 'America/Tijuana';
    r.agenda.capacidad_por_slot = 20;
    r.agenda.cupo_diario = 5;
    r.mensajes.recordatorios.h2.horas_antes = 30;
    r.agenda.antelacion_min_horas = 0;
    expect(advertenciasReglas(r).map((a) => a.codigo).sort()).toEqual(['CAPACIDAD_MAYOR_QUE_CUPO', 'RECORDATORIOS_INVERTIDOS', 'RETENCION_SIN_ANTELACION', 'ZONAS_DISTINTAS']);
  });
});
