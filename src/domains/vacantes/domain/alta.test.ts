import { describe, expect, it } from 'vitest';
import { AsignacionSchema, NuevaVacanteSchema, NuevoClienteSchema, slugDesdeNombre } from './alta.ts';

const UUID = '10000000-0000-4000-8000-00000000000a';

describe('Alta sin código (NFR-ESC-06)', () => {
  it('cliente: nombre 1–200, recortado', () => {
    expect(NuevoClienteSchema.parse({ nombre: '  ACME  ' })).toEqual({ nombre: 'ACME' });
    expect(NuevoClienteSchema.safeParse({ nombre: '' }).success).toBe(false);
    expect(NuevoClienteSchema.safeParse({ nombre: 'x'.repeat(201) }).success).toBe(false);
  });

  it('vacante: slug kebab, código en mayúsculas, nombre y cliente uuid', () => {
    const v = NuevaVacanteSchema.parse({ cliente_id: UUID, slug: 'agente-smart', codigo: 'as-01', nombre: 'Agente Smart' });
    expect(v).toEqual({ cliente_id: UUID, slug: 'agente-smart', codigo: 'AS-01', nombre: 'Agente Smart' });
    for (const slug of ['Agente', 'agente_smart', '-a', 'a--b', '']) expect(NuevaVacanteSchema.safeParse({ cliente_id: UUID, slug, codigo: 'X1', nombre: 'n' }).success).toBe(false);
    expect(NuevaVacanteSchema.safeParse({ cliente_id: 'x', slug: 'a', codigo: 'X1', nombre: 'n' }).success).toBe(false);
    expect(NuevaVacanteSchema.safeParse({ cliente_id: UUID, slug: 'a', codigo: 'X 1', nombre: 'n' }).success).toBe(false);
  });

  it('vacante: reglas iniciales opcionales', () => {
    const v = NuevaVacanteSchema.parse({ cliente_id: UUID, slug: 'a', codigo: 'A', nombre: 'n', reglas: { agenda: { cupo_diario: 4 } } });
    expect(v.reglas).toEqual({ agenda: { cupo_diario: 4 } });
  });

  it('asignación: correo, rol del panel y vacante', () => {
    expect(AsignacionSchema.parse({ email: ' Ana@Ejemplo.MX ', rol: 'reclutador', vacante_id: UUID })).toEqual({ email: 'ana@ejemplo.mx', rol: 'reclutador', vacante_id: UUID });
    expect(AsignacionSchema.safeParse({ email: 'no-es-correo', rol: 'reclutador', vacante_id: UUID }).success).toBe(false);
    expect(AsignacionSchema.safeParse({ email: 'a@b.mx', rol: 'admin', vacante_id: UUID }).success).toBe(false);
  });

  it('slugDesdeNombre sugiere un slug válido (sin acentos ni símbolos)', () => {
    expect(slugDesdeNombre('  Agente Smart · Monterrey Ñandú  ')).toBe('agente-smart-monterrey-nandu');
    expect(slugDesdeNombre('***')).toBe('');
  });
});
