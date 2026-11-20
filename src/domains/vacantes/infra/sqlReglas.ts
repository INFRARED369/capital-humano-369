/**
 * Adaptador SQL de RepoReglas sobre las funciones security definer de config (migración 20261113050001).
 * Corre con la conexión de servicio y fija, SOLO dentro de la transacción, los claims del usuario
 * verificado: así auth.uid(), es_admin() y puede_operar_vacante() deciden por él.
 */
import { err, ok, type Result } from '@shared/result.ts';
import type { SqlClient } from '@shared/sql.ts';
import type { Cambio } from '../domain/diff.ts';
import type { ContextoUsuario, ErrorRepo, RepoReglas } from '../application/puertos.ts';

const CODIGOS: readonly ErrorRepo[] = ['PERMISO_DENEGADO', 'NO_ENCONTRADA', 'VERSION_CONFLICTO', 'REGLAS_INVALIDAS', 'USUARIO_NO_ENCONTRADO'];

/** Traduce la excepción de Postgres a un código de negocio; lo desconocido se relanza. */
export function errorDeSql(e: unknown): ErrorRepo {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code;
  const conocido = CODIGOS.find((c) => msg.startsWith(c));
  if (conocido) return conocido;
  if (code === '23505' || /duplicate key/i.test(msg)) return 'DUPLICADO';
  if (code === '42501' || /permission denied/i.test(msg)) return 'PERMISO_DENEGADO';
  throw e;
}

async function comoUsuario<T>(sql: SqlClient, ctx: ContextoUsuario, fn: (tx: SqlClient) => Promise<T>): Promise<Result<T, ErrorRepo>> {
  if (!ctx.usuarioId) return err('PERMISO_DENEGADO');
  try {
    const valor = await sql.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ctx.usuarioId, role: 'authenticated' })]);
      return fn(tx);
    });
    return ok(valor);
  } catch (e) {
    return err(errorDeSql(e));
  }
}

interface FilaGuardar { vacante_id: string; version: number; diff: Cambio[]; sin_cambios: boolean }

export function crearRepoReglasSql(sql: SqlClient): RepoReglas {
  return {
    guardar: (ctx, e) =>
      comoUsuario(sql, ctx, async (tx) => {
        const { rows } = await tx.query<{ r: FilaGuardar }>(`select config.guardar_reglas($1, $2::jsonb, $3) as r`, [e.vacanteId, JSON.stringify(e.reglas), e.versionBase]);
        const r = rows[0]!.r;
        return { vacanteId: r.vacante_id, version: r.version, diff: r.diff, sinCambios: r.sin_cambios };
      }),

    crearCliente: (ctx, e) =>
      comoUsuario(sql, ctx, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(`select config.crear_cliente($1) as id`, [e.nombre]);
        return { clienteId: rows[0]!.id };
      }),

    crearVacante: (ctx, e) =>
      comoUsuario(sql, ctx, async (tx) => {
        const { rows } = await tx.query<{ r: { vacante_id: string; version: number | null } }>(`select config.crear_vacante($1, $2, $3, $4, $5::jsonb) as r`, [
          e.cliente_id,
          e.slug,
          e.codigo,
          e.nombre,
          e.reglas === undefined ? null : JSON.stringify(e.reglas),
        ]);
        return { vacanteId: rows[0]!.r.vacante_id, version: rows[0]!.r.version ?? null };
      }),

    asignar: (ctx, e) =>
      comoUsuario(sql, ctx, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(`select config.asignar_usuario($1, $2, $3) as id`, [e.email, e.rol, e.vacante_id]);
        return { userId: rows[0]!.id };
      }),
  };
}
