/**
 * Edge function `panel-reglas` — POST { operacion, datos } con `Authorization: Bearer <access token>`.
 *   guardar_reglas  { vacante_id, reglas, version_base } → 200 { vacante_id, version, reglas, diff, sin_cambios }
 *   crear_cliente   { nombre }                           → 201 { cliente_id }
 *   crear_vacante   { cliente_id, slug, codigo, nombre, reglas? } → 201 { vacante_id, version }
 *   asignar_usuario { email, rol, vacante_id }           → 200 { user_id }
 * Errores: 400 ENTRADA_INVALIDA (+problemas) · 401 SIN_SESION/SESION_INVALIDA · 403 PERMISO_DENEGADO|ORIGEN_NO_PERMITIDO
 * · 404 NO_ENCONTRADA|USUARIO_NO_ENCONTRADO · 409 VERSION_CONFLICTO|DUPLICADO · 413 · 415 · 422 REGLAS_INVALIDAS (+problemas) · 429 · 500.
 */
import { z } from 'zod';
import { cors, correlationId, json } from '@shared/http.ts';
import { crearLogger, type Sink } from '@shared/logger.ts';
import type { Result } from '@shared/result.ts';
import { asignarUsuarioCaso, crearClienteCaso, crearVacanteCaso, guardarReglasCaso, type ErrorCaso } from '../../application/casosDeUso.ts';
import type { ContextoUsuario, RepoReglas, VerificadorSesion } from '../../application/puertos.ts';
import { extraerBearer } from '../authSupabase.ts';

export interface LimitadorPanel { permitir(clave: string): Promise<{ ok: boolean; reintentarEnSeg: number }> }

export interface DepsPanelReglas {
  repo: RepoReglas;
  sesion: VerificadorSesion;
  allowedOrigin: readonly string[];
  limitador?: LimitadorPanel;
  sink?: Sink;
}

const MAX_BYTES = 128 * 1024;
const CuerpoSchema = z.strictObject({
  operacion: z.enum(['guardar_reglas', 'crear_cliente', 'crear_vacante', 'asignar_usuario']),
  datos: z.unknown(),
});

const STATUS: Record<ErrorCaso['codigo'], number> = {
  ENTRADA_INVALIDA: 400,
  PERMISO_DENEGADO: 403,
  NO_ENCONTRADA: 404,
  USUARIO_NO_ENCONTRADO: 404,
  VERSION_CONFLICTO: 409,
  DUPLICADO: 409,
  REGLAS_INVALIDAS: 422,
};

type Operacion = z.output<typeof CuerpoSchema>['operacion'];
type Ejecutor = (repo: RepoReglas, ctx: ContextoUsuario, datos: unknown) => Promise<Result<unknown, ErrorCaso> & { status?: number }>;

const OPERACIONES: Record<Operacion, { exito: number; ejecutar: Ejecutor; salida: (v: never) => unknown }> = {
  guardar_reglas: {
    exito: 200,
    ejecutar: guardarReglasCaso,
    salida: (v: Awaited<ReturnType<typeof guardarReglasCaso>> extends Result<infer T, ErrorCaso> ? T : never) => ({
      vacante_id: v.vacanteId, version: v.version, reglas: v.reglas, diff: v.diff, sin_cambios: v.sinCambios,
    }),
  },
  crear_cliente: { exito: 201, ejecutar: crearClienteCaso, salida: (v: { clienteId: string }) => ({ cliente_id: v.clienteId }) },
  crear_vacante: { exito: 201, ejecutar: crearVacanteCaso, salida: (v: { vacanteId: string; version: number | null }) => ({ vacante_id: v.vacanteId, version: v.version }) },
  asignar_usuario: { exito: 200, ejecutar: asignarUsuarioCaso, salida: (v: { userId: string }) => ({ user_id: v.userId }) },
};

export function crearHandlerPanelReglas(deps: DepsPanelReglas): (req: Request) => Promise<Response> {
  const base = crearLogger({ funcion: 'panel-reglas' }, deps.sink);
  return async (req) => {
    const cid = correlationId(req);
    const log = base.child({ correlation_id: cid });
    const origen = req.headers.get('origin');
    const headers = { ...cors(origen && deps.allowedOrigin.includes(origen) ? origen : (deps.allowedOrigin[0] ?? 'null')), 'x-correlation-id': cid };
    const responder = (body: unknown, status = 200, extra: Record<string, string> = {}) => json(body, status, { ...headers, ...extra });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return responder({ error: 'METODO_NO_PERMITIDO' }, 405, { allow: 'POST, OPTIONS' });
    if (origen && !deps.allowedOrigin.includes(origen)) return responder({ error: 'ORIGEN_NO_PERMITIDO' }, 403);

    try {
      const token = extraerBearer(req.headers.get('authorization'));
      if (!token) return responder({ error: 'SIN_SESION' }, 401);
      const usuario = await deps.sesion.verificar(token);
      if (!usuario) return responder({ error: 'SESION_INVALIDA' }, 401);

      const lim = await deps.limitador?.permitir(usuario.usuarioId);
      if (lim && lim.ok === false) return responder({ error: 'DEMASIADAS_PETICIONES' }, 429, { 'retry-after': String(lim.reintentarEnSeg) });

      if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return responder({ error: 'TIPO_NO_SOPORTADO' }, 415);
      const texto = await req.text();
      if (new TextEncoder().encode(texto).length > MAX_BYTES) return responder({ error: 'CUERPO_DEMASIADO_GRANDE' }, 413);
      let crudo: unknown;
      try {
        crudo = JSON.parse(texto);
      } catch {
        return responder({ error: 'JSON_INVALIDO' }, 400);
      }
      const cuerpo = CuerpoSchema.safeParse(crudo);
      if (cuerpo.success === false) return responder({ error: 'OPERACION_INVALIDA' }, 400);

      const op = OPERACIONES[cuerpo.data.operacion];
      const r = await op.ejecutar(deps.repo, { usuarioId: usuario.usuarioId }, cuerpo.data.datos);
      const vacante = (cuerpo.data.datos as { vacante_id?: unknown } | null)?.vacante_id;
      if (r.ok === false) {
        log.warn('operación rechazada', { operacion: cuerpo.data.operacion, error: r.error.codigo, usuario_id: usuario.usuarioId, vacante_id: typeof vacante === 'string' ? vacante.slice(0, 40) : undefined });
        return responder(r.error.problemas ? { error: r.error.codigo, problemas: r.error.problemas } : { error: r.error.codigo }, STATUS[r.error.codigo]);
      }
      log.info('operación aplicada', { operacion: cuerpo.data.operacion, usuario_id: usuario.usuarioId, vacante_id: typeof vacante === 'string' ? vacante.slice(0, 40) : undefined });
      return responder(op.salida(r.value as never), op.exito);
    } catch (e) {
      log.error('error no controlado', { error: e instanceof Error ? e.name : 'desconocido' });
      return responder({ error: 'ERROR_INTERNO' }, 500);
    }
  };
}
