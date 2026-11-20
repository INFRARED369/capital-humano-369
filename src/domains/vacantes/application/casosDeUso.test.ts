import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@shared/result.ts';
import { PLANTILLA_VACANTE_DEFECTO } from '../domain/reglas.ts';
import { asignarUsuarioCaso, crearClienteCaso, crearVacanteCaso, guardarReglasCaso } from './casosDeUso.ts';
import type { RepoReglas } from './puertos.ts';

const UUID = '10000000-0000-4000-8000-00000000000a';
const ctx = { usuarioId: '00000000-0000-4000-8000-0000000000ad' };

function repoFalso(over: Partial<RepoReglas> = {}): RepoReglas {
  return {
    guardar: vi.fn(async (_c, e) => ok({ vacanteId: e.vacanteId, version: 2, diff: [], sinCambios: false })),
    crearCliente: vi.fn(async () => ok({ clienteId: UUID })),
    crearVacante: vi.fn(async () => ok({ vacanteId: UUID, version: null })),
    asignar: vi.fn(async () => ok({ userId: UUID })),
    ...over,
  };
}

describe('guardarReglasCaso: Zod en el servidor ANTES de la BD', () => {
  it('normaliza (completa con la plantilla) y guarda lo normalizado', async () => {
    const repo = repoFalso();
    const r = await guardarReglasCaso(repo, ctx, { vacante_id: UUID, reglas: { agenda: { cupo_diario: 5 } }, version_base: 1 });
    expect(r.ok).toBe(true);
    const llamada = vi.mocked(repo.guardar).mock.calls[0]![1];
    expect(llamada.versionBase).toBe(1);
    expect(llamada.reglas.agenda.cupo_diario).toBe(5);
    expect(llamada.reglas.agenda.intervalo_min).toBe(30);
    expect(r.ok && r.value.reglas).toEqual(llamada.reglas);
  });

  it('reglas inválidas → REGLAS_INVALIDAS con problemas y sin tocar la BD', async () => {
    const repo = repoFalso();
    const r = await guardarReglasCaso(repo, ctx, { vacante_id: UUID, reglas: { agenda: { cupo_diario: 0 } }, version_base: 0 });
    expect(r).toEqual({ ok: false, error: { codigo: 'REGLAS_INVALIDAS', problemas: [expect.objectContaining({ ruta: 'agenda.cupo_diario' })] } });
    expect(repo.guardar).not.toHaveBeenCalled();
  });

  it('entrada mal formada (vacante no uuid, versión negativa, campos extra) → ENTRADA_INVALIDA', async () => {
    const repo = repoFalso();
    for (const e of [{ vacante_id: 'x', reglas: {}, version_base: 0 }, { vacante_id: UUID, reglas: {}, version_base: -1 }, { vacante_id: UUID, reglas: {}, version_base: 0, extra: 1 }, null]) {
      const r = await guardarReglasCaso(repo, ctx, e);
      expect(!r.ok && r.error.codigo).toBe('ENTRADA_INVALIDA');
    }
    expect(repo.guardar).not.toHaveBeenCalled();
  });

  it('propaga los errores del repositorio (S3: PERMISO_DENEGADO)', async () => {
    const repo = repoFalso({ guardar: async () => err('PERMISO_DENEGADO') });
    expect(await guardarReglasCaso(repo, ctx, { vacante_id: UUID, reglas: PLANTILLA_VACANTE_DEFECTO, version_base: 0 })).toEqual({ ok: false, error: { codigo: 'PERMISO_DENEGADO' } });
  });
});

describe('alta (NFR-ESC-06)', () => {
  it('crear cliente valida el nombre', async () => {
    const repo = repoFalso();
    expect(await crearClienteCaso(repo, ctx, { nombre: ' ACME ' })).toEqual({ ok: true, value: { clienteId: UUID } });
    expect(vi.mocked(repo.crearCliente).mock.calls[0]![1]).toEqual({ nombre: 'ACME' });
    expect(!((await crearClienteCaso(repo, ctx, { nombre: '' })).ok)).toBe(true);
  });

  it('crear vacante: con reglas iniciales las normaliza; sin reglas no manda reglas', async () => {
    const repo = repoFalso();
    await crearVacanteCaso(repo, ctx, { cliente_id: UUID, slug: 'nueva', codigo: 'n-1', nombre: 'Nueva', reglas: { agenda: { cupo_diario: 4 } } });
    const e1 = vi.mocked(repo.crearVacante).mock.calls[0]![1];
    expect(e1.codigo).toBe('N-1');
    expect(e1.reglas?.agenda.cupo_diario).toBe(4);
    await crearVacanteCaso(repo, ctx, { cliente_id: UUID, slug: 'nueva2', codigo: 'N2', nombre: 'Nueva' });
    expect(vi.mocked(repo.crearVacante).mock.calls[1]![1].reglas).toBeUndefined();
  });

  it('crear vacante con reglas inválidas → REGLAS_INVALIDAS; con slug inválido → ENTRADA_INVALIDA', async () => {
    const repo = repoFalso();
    const r1 = await crearVacanteCaso(repo, ctx, { cliente_id: UUID, slug: 'nueva', codigo: 'N', nombre: 'n', reglas: { agenda: { cupo_diario: -1 } } });
    expect(!r1.ok && r1.error.codigo).toBe('REGLAS_INVALIDAS');
    const r2 = await crearVacanteCaso(repo, ctx, { cliente_id: UUID, slug: 'No Valido', codigo: 'N', nombre: 'n' });
    expect(!r2.ok && r2.error.codigo).toBe('ENTRADA_INVALIDA');
    expect(!r2.ok && r2.error.problemas?.[0]?.ruta).toBe('slug');
    expect(repo.crearVacante).not.toHaveBeenCalled();
  });

  it('asignar usuario valida correo y rol, y propaga USUARIO_NO_ENCONTRADO', async () => {
    const repo = repoFalso({ asignar: async () => err('USUARIO_NO_ENCONTRADO') });
    expect(await asignarUsuarioCaso(repo, ctx, { email: 'a@b.mx', rol: 'reclutador', vacante_id: UUID })).toEqual({ ok: false, error: { codigo: 'USUARIO_NO_ENCONTRADO' } });
    const r = await asignarUsuarioCaso(repo, ctx, { email: 'a', rol: 'reclutador', vacante_id: UUID });
    expect(!r.ok && r.error.codigo).toBe('ENTRADA_INVALIDA');
  });
});
