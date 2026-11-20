/**
 * Casos de uso del panel para vacantes. La validación completa (Zod) ocurre aquí, en el servidor,
 * antes de llegar a la BD; la SQL solo valida lo mínimo y decide permisos (S3).
 */
import { z } from 'zod';
import { err, ok, type Result } from '@shared/result.ts';
import { AsignacionSchema, NuevaVacanteSchema, NuevoClienteSchema } from '../domain/alta.ts';
import { normalizarReglas, type Problema, type ReglasVacante } from '../domain/reglas.ts';
import type { ContextoUsuario, ErrorRepo, ReglasGuardadas, RepoReglas } from './puertos.ts';

export type CodigoError = ErrorRepo | 'ENTRADA_INVALIDA';
export interface ErrorCaso { codigo: CodigoError; problemas?: Problema[] }

const problemasDe = (e: z.ZodError): Problema[] => e.issues.map((i) => ({ ruta: i.path.map(String).join('.'), mensaje: i.message }));

function validar<S extends z.ZodType>(schema: S, entrada: unknown): Result<z.output<S>, ErrorCaso> {
  const r = schema.safeParse(entrada);
  return r.success === true ? ok(r.data) : err({ codigo: 'ENTRADA_INVALIDA', problemas: problemasDe(r.error) });
}

const deRepo = <T>(r: Result<T, ErrorRepo>): Result<T, ErrorCaso> => (r.ok === true ? r : err({ codigo: r.error }));

function reglasValidas(entrada: unknown): Result<ReglasVacante, ErrorCaso> {
  const r = normalizarReglas(entrada);
  return r.ok === true ? r : err({ codigo: 'REGLAS_INVALIDAS', problemas: r.error });
}

export const GuardarReglasSchema = z.strictObject({
  vacante_id: z.uuid(),
  reglas: z.unknown(),
  /** Versión que el editor cargó (0 si la vacante aún usa la plantilla). */
  version_base: z.number().int().min(0),
});

export async function guardarReglasCaso(repo: RepoReglas, ctx: ContextoUsuario, entrada: unknown): Promise<Result<ReglasGuardadas & { reglas: ReglasVacante }, ErrorCaso>> {
  const e = validar(GuardarReglasSchema, entrada);
  if (e.ok === false) return e;
  const reglas = reglasValidas(e.value.reglas);
  if (reglas.ok === false) return reglas;
  const r = await repo.guardar(ctx, { vacanteId: e.value.vacante_id, reglas: reglas.value, versionBase: e.value.version_base });
  return r.ok === true ? ok({ ...r.value, reglas: reglas.value }) : err({ codigo: r.error });
}

export async function crearClienteCaso(repo: RepoReglas, ctx: ContextoUsuario, entrada: unknown): Promise<Result<{ clienteId: string }, ErrorCaso>> {
  const e = validar(NuevoClienteSchema, entrada);
  return e.ok === true ? deRepo(await repo.crearCliente(ctx, e.value)) : e;
}

export async function crearVacanteCaso(repo: RepoReglas, ctx: ContextoUsuario, entrada: unknown): Promise<Result<{ vacanteId: string; version: number | null }, ErrorCaso>> {
  const e = validar(NuevaVacanteSchema, entrada);
  if (e.ok === false) return e;
  const { reglas: crudas, ...vacante } = e.value;
  if (crudas === undefined) return deRepo(await repo.crearVacante(ctx, vacante));
  const reglas = reglasValidas(crudas);
  if (reglas.ok === false) return reglas;
  return deRepo(await repo.crearVacante(ctx, { ...vacante, reglas: reglas.value }));
}

export async function asignarUsuarioCaso(repo: RepoReglas, ctx: ContextoUsuario, entrada: unknown): Promise<Result<{ userId: string }, ErrorCaso>> {
  const e = validar(AsignacionSchema, entrada);
  return e.ok === true ? deRepo(await repo.asignar(ctx, e.value)) : e;
}
