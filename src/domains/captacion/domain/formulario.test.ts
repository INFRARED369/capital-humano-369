import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@shared/ids.ts';
import { PreguntasSchema, construirEsquemaPostulacion, validarPostulacion, type Pregunta } from './formulario.ts';

const preguntas: Pregunta[] = [
  { id: 'edad', etiqueta: 'Edad', tipo: 'numero', requerida: true, min: 14, max: 99 },
  { id: 'municipio', etiqueta: 'Municipio', tipo: 'opcion', requerida: true, presentacion: 'select', opciones: [{ valor: 'Monterrey', etiqueta: 'Monterrey' }, { valor: 'Otro', etiqueta: 'Otro' }] },
  { id: 'pc', etiqueta: '¿Manejas PC?', tipo: 'opcion', requerida: true, presentacion: 'tarjetas', opciones: [{ valor: 'si', etiqueta: 'Sí' }, { valor: 'no', etiqueta: 'No' }] },
  { id: 'comentario', etiqueta: 'Comentario', tipo: 'texto', requerida: false, max: 200 },
];

const valido = () => ({
  vacante: 'agente-smart',
  nombre: 'Mariana Garza López',
  telefono: '81 1234 5678',
  respuestas: { edad: 22, municipio: 'Monterrey', pc: 'si' },
  slot_inicio: '2026-11-17T16:00:00.000Z',
  consentimiento: { aceptado: true, version: '2026-11-13' },
  turnstile_token: 'tok',
  event_id: uuidv7(),
});

describe('PreguntasSchema (contenido JSON)', () => {
  it('acepta preguntas válidas y rechaza ids duplicados u opciones vacías', () => {
    expect(PreguntasSchema.safeParse(preguntas).success).toBe(true);
    expect(PreguntasSchema.safeParse([preguntas[0], preguntas[0]]).success).toBe(false);
    expect(PreguntasSchema.safeParse([{ id: 'x', etiqueta: 'X', tipo: 'opcion', requerida: true, opciones: [] }]).success).toBe(false);
    expect(PreguntasSchema.safeParse([{ id: 'Mal Id', etiqueta: 'X', tipo: 'texto', requerida: true }]).success).toBe(false);
  });
});

describe('P1 · cualquier combinación de respuestas es un lead válido (D4)', () => {
  it('respuestas "no" a todo y edad baja no descalifican', () => {
    const r = validarPostulacion({ ...valido(), respuestas: { edad: 15, municipio: 'Otro', pc: 'no' } }, preguntas);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.respuestas).toEqual({ edad: 15, municipio: 'Otro', pc: 'no' });
      expect(r.value.telefonoE164).toBe('528112345678');
      expect(r.value.nombre).toBe('Mariana Garza López');
      expect(r.value.nombrePila).toBe('Mariana');
    }
  });
  it('acepta email opcional vacío y atribución', () => {
    const r = validarPostulacion({ ...valido(), email: '', atribucion: { visitor_id: 'v-1', utm_source: 'facebook', fbclid: 'abc' } }, preguntas);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.email).toBeNull();
      expect(r.value.atribucion).toEqual({ visitor_id: 'v-1', utm_source: 'facebook', fbclid: 'abc' });
    }
  });
  it('normaliza email a minúsculas', () => {
    const r = validarPostulacion({ ...valido(), email: 'Ana@Correo.MX' }, preguntas);
    expect(r.ok && r.value.email).toBe('ana@correo.mx');
  });
});

describe('P2 · formato', () => {
  it.each([
    ['teléfono de 9 dígitos', { telefono: '811234567' }, 'telefono'],
    ['teléfono con letras', { telefono: '81123456ab' }, 'telefono'],
    ['nombre vacío', { nombre: '   ' }, 'nombre'],
    ['pregunta obligatoria ausente', { respuestas: { edad: 22, municipio: 'Monterrey' } }, 'respuestas.pc'],
    ['opción fuera de catálogo', { respuestas: { edad: 22, municipio: 'Marte', pc: 'si' } }, 'respuestas.municipio'],
    ['número fuera de rango', { respuestas: { edad: 7, municipio: 'Monterrey', pc: 'si' } }, 'respuestas.edad'],
    ['número no entero', { respuestas: { edad: 22.5, municipio: 'Monterrey', pc: 'si' } }, 'respuestas.edad'],
    ['slot inválido', { slot_inicio: 'mañana' }, 'slot_inicio'],
    ['email inválido', { email: 'no-es-correo' }, 'email'],
    ['event_id que no es uuid v7', { event_id: 'abc' }, 'event_id'],
  ])('%s → error en %s', (_n, cambio, campo) => {
    const r = validarPostulacion({ ...valido(), ...cambio }, preguntas);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.codigo).toBe('FORMATO_INVALIDO');
      expect(r.error.campos.map((c) => c.campo)).toContain(campo);
    }
  });
  it('los mensajes de error no repiten los valores enviados', () => {
    const r = validarPostulacion({ ...valido(), telefono: '811234567' }, preguntas);
    expect(JSON.stringify(r)).not.toContain('811234567');
  });
});

describe('P4 · campos extra y tamaños excesivos', () => {
  it('rechaza campos desconocidos en raíz, respuestas, consentimiento y atribución', () => {
    for (const extra of [
      { admin: true },
      { respuestas: { ...valido().respuestas, descalificado: false } },
      { consentimiento: { aceptado: true, version: 'v', extra: 1 } },
      { atribucion: { foo: 'bar' } },
    ]) {
      const r = validarPostulacion({ ...valido(), ...extra }, preguntas);
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
  });
  it('rechaza textos demasiado largos', () => {
    expect(validarPostulacion({ ...valido(), nombre: 'a'.repeat(121) }, preguntas).ok).toBe(false);
    expect(validarPostulacion({ ...valido(), respuestas: { ...valido().respuestas, comentario: 'x'.repeat(201) } }, preguntas).ok).toBe(false);
    expect(validarPostulacion({ ...valido(), atribucion: { utm_source: 'x'.repeat(501) } }, preguntas).ok).toBe(false);
  });
  it('rechaza un cuerpo que no es objeto', () => {
    expect(validarPostulacion(null, preguntas).ok).toBe(false);
    expect(validarPostulacion('x', preguntas).ok).toBe(false);
  });
});

describe('P6 · consentimiento obligatorio', () => {
  it('sin consentimiento → CONSENTIMIENTO_REQUERIDO', () => {
    for (const consentimiento of [{ aceptado: false, version: 'v' }, undefined]) {
      const r = validarPostulacion({ ...valido(), consentimiento }, preguntas);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.codigo).toBe('CONSENTIMIENTO_REQUERIDO');
    }
  });
  it('sin token anti-bot → ANTIBOT_REQUERIDO', () => {
    const r = validarPostulacion({ ...valido(), turnstile_token: '' }, preguntas);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.codigo).toBe('ANTIBOT_REQUERIDO');
  });
});

describe('esquema reutilizable en el cliente', () => {
  it('construirEsquemaPostulacion devuelve un esquema Zod estricto', () => {
    const s = construirEsquemaPostulacion(preguntas);
    expect(s.safeParse(valido()).success).toBe(true);
    expect(s.safeParse({ ...valido(), x: 1 }).success).toBe(false);
  });
  it('texto opcional vacío se omite', () => {
    const r = validarPostulacion({ ...valido(), respuestas: { ...valido().respuestas, comentario: '  ' } }, preguntas);
    expect(r.ok && r.value.respuestas).toEqual({ edad: 22, municipio: 'Monterrey', pc: 'si' });
  });
  it('número enviado como texto numérico se acepta (inputs HTML)', () => {
    const r = validarPostulacion({ ...valido(), respuestas: { ...valido().respuestas, edad: '30' } }, preguntas);
    expect(r.ok && r.value.respuestas.edad).toBe(30);
  });
});
