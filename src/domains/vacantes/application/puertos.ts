/** Puertos del dominio vacantes. Los implementa infra/ (SQL) y se cablean en la edge function panel-reglas. */
import type { Result } from '@shared/result.ts';
import type { Asignacion, NuevaVacante, NuevoCliente } from '../domain/alta.ts';
import type { Cambio } from '../domain/diff.ts';
import type { ReglasVacante } from '../domain/reglas.ts';

/** Usuario verificado por Supabase Auth (null = sin sesión). */
export interface ContextoUsuario { usuarioId: string | null }

export type ErrorRepo = 'PERMISO_DENEGADO' | 'NO_ENCONTRADA' | 'VERSION_CONFLICTO' | 'REGLAS_INVALIDAS' | 'DUPLICADO' | 'USUARIO_NO_ENCONTRADO';

export interface ReglasGuardadas { vacanteId: string; version: number; diff: Cambio[]; sinCambios: boolean }

export interface RepoReglas {
  guardar(ctx: ContextoUsuario, e: { vacanteId: string; reglas: ReglasVacante; versionBase: number | null }): Promise<Result<ReglasGuardadas, ErrorRepo>>;
  crearCliente(ctx: ContextoUsuario, e: NuevoCliente): Promise<Result<{ clienteId: string }, ErrorRepo>>;
  crearVacante(ctx: ContextoUsuario, e: Omit<NuevaVacante, 'reglas'> & { reglas?: ReglasVacante }): Promise<Result<{ vacanteId: string; version: number | null }, ErrorRepo>>;
  asignar(ctx: ContextoUsuario, e: Asignacion): Promise<Result<{ userId: string }, ErrorRepo>>;
}

/** Verifica el access token de Supabase Auth y devuelve el usuario (o null si no es válido). */
export interface VerificadorSesion {
  verificar(accessToken: string): Promise<{ usuarioId: string } | null>;
}
