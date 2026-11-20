/**
 * API pública del dominio vacantes (configuración/reglas operativas por vacante, D6/D7, DSH-04).
 * El navegador (panel) usa el esquema, la plantilla, el diff y las advertencias; la edge function
 * `panel-reglas` usa el handler, el repositorio SQL y el verificador de sesión.
 */
export {
  ReglasVacanteSchema,
  PLANTILLA_VACANTE_DEFECTO,
  MAX_BYTES_REGLAS,
  normalizarReglas,
  advertenciasReglas,
  type ReglasVacante,
  type Problema,
  type Advertencia,
  type CodigoAdvertencia,
} from './domain/reglas.ts';
export { diffReglas, type Cambio } from './domain/diff.ts';
export { NuevoClienteSchema, NuevaVacanteSchema, AsignacionSchema, slugDesdeNombre, type NuevoCliente, type NuevaVacante, type Asignacion } from './domain/alta.ts';
export { guardarReglasCaso, crearClienteCaso, crearVacanteCaso, asignarUsuarioCaso, GuardarReglasSchema, type ErrorCaso, type CodigoError } from './application/casosDeUso.ts';
export type { RepoReglas, VerificadorSesion, ContextoUsuario, ErrorRepo, ReglasGuardadas } from './application/puertos.ts';
export { crearRepoReglasSql } from './infra/sqlReglas.ts';
export { crearVerificadorSupabaseAuth, extraerBearer } from './infra/authSupabase.ts';
export { crearHandlerPanelReglas, type DepsPanelReglas, type LimitadorPanel } from './infra/http/panelReglas.ts';
