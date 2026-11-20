/** Cliente HTTP de las edge functions del panel (con la sesión de Supabase Auth). */
import type { Problema } from '../../../../src/domains/vacantes';

export type OperacionPanel = 'guardar_reglas' | 'crear_cliente' | 'crear_vacante' | 'asignar_usuario';
export type RespuestaPanel<T = Record<string, unknown>> = { tipo: 'ok'; datos: T } | { tipo: 'error'; status: number; codigo: string; problemas: Problema[] };

export function crearClienteFunciones(baseUrl: string, fetchImpl: typeof fetch, token: () => Promise<string | null>) {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async panelReglas<T = Record<string, unknown>>(operacion: OperacionPanel, datos: unknown): Promise<RespuestaPanel<T>> {
      const t = await token();
      if (!t) return { tipo: 'error', status: 401, codigo: 'SIN_SESION', problemas: [] };
      try {
        const r = await fetchImpl(`${base}/panel-reglas`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
          body: JSON.stringify({ operacion, datos }),
          signal: AbortSignal.timeout(15_000),
        });
        const cuerpo = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (r.ok) return { tipo: 'ok', datos: cuerpo as T };
        return { tipo: 'error', status: r.status, codigo: typeof cuerpo.error === 'string' ? cuerpo.error : 'DESCONOCIDO', problemas: Array.isArray(cuerpo.problemas) ? (cuerpo.problemas as Problema[]) : [] };
      } catch {
        return { tipo: 'error', status: 0, codigo: 'RED', problemas: [] };
      }
    },
  };
}

const MENSAJES: Record<string, string> = {
  PERMISO_DENEGADO: 'No tienes permiso para esta acción.',
  VERSION_CONFLICTO: 'Alguien guardó otra versión mientras editabas. Recarga para ver la versión actual.',
  REGLAS_INVALIDAS: 'Hay reglas inválidas; revisa los campos marcados.',
  ENTRADA_INVALIDA: 'Revisa los campos marcados.',
  SIN_SESION: 'Tu sesión terminó. Vuelve a iniciar sesión.',
  SESION_INVALIDA: 'Tu sesión terminó. Vuelve a iniciar sesión.',
  DUPLICADO: 'Ya existe un registro con ese slug o código.',
  NO_ENCONTRADA: 'No se encontró el registro.',
  USUARIO_NO_ENCONTRADO: 'No existe un usuario con ese correo. Invítalo primero desde Supabase Auth.',
  DEMASIADAS_PETICIONES: 'Demasiados intentos; espera un momento.',
  RED: 'No hay conexión con el servidor. Intenta de nuevo.',
};
export const mensajePanel = (codigo: string) => MENSAJES[codigo] ?? 'Ocurrió un error inesperado. Intenta de nuevo.';
