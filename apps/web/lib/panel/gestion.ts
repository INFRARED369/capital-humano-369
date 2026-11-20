/**
 * Página pública /cita/gestionar/?t=<token> (CIT-11, C15, E2E-10): el candidato cancela o reprograma con el
 * link firmado. La acción y la cita salen solo del token (lo decide gestionar-cita).
 */
import { z } from 'zod';
import { leerToken } from './rutas';

const CLAVE_TOKEN = '369-cita-token';

interface VentanaToken {
  location: { pathname: string; search: string; hash: string };
  history: { state?: unknown; replaceState(data: unknown, unused: string, url?: string): void };
  sessionStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
}

/**
 * Toma el token del link firmado y lo quita de la URL antes de que carguen terceros (Pixel, Clarity) o se
 * navegue a otro sitio (Referer): el token permite cancelar/reprogramar la cita hasta que vence.
 * Se conserva en sessionStorage (solo esta pestaña) para sobrevivir a una recarga.
 */
/** Quita la query conservando el estado de historial del router de Next. */
export function quitarDeUrl(win: Pick<VentanaToken, 'location' | 'history'>): void {
  if (win.location.search) win.history.replaceState(win.history.state ?? null, '', `${win.location.pathname}${win.location.hash}`);
}

export function tomarToken(win: VentanaToken): string | null {
  const enUrl = leerToken(win.location.search);
  try {
    if (enUrl) {
      win.sessionStorage.setItem(CLAVE_TOKEN, enUrl);
      quitarDeUrl(win);
      return enUrl;
    }
    return win.sessionStorage.getItem(CLAVE_TOKEN);
  } catch {
    return enUrl;
  }
}

export type Resultado<T> = { tipo: 'ok'; status: number; cuerpo: T } | { tipo: 'error'; status: number; codigo: string };

export function crearClienteGestion(baseUrl: string, fetchImpl: typeof fetch = (i, init) => fetch(i, init)) {
  const url = `${baseUrl.replace(/\/+$/, '')}/gestionar-cita`;
  async function post(cuerpo: Record<string, unknown>): Promise<Resultado<unknown>> {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(15_000) });
      const json = (await r.json().catch(() => ({}))) as { error?: unknown };
      if (r.ok) return { tipo: 'ok', status: r.status, cuerpo: json };
      return { tipo: 'error', status: r.status, codigo: typeof json.error === 'string' ? json.error : r.status >= 500 ? 'ERROR_INTERNO' : 'DESCONOCIDO' };
    } catch {
      return { tipo: 'error', status: 0, codigo: 'RED' };
    }
  }
  return {
    consultar: (token: string) => post({ token, operacion: 'consultar' }),
    ejecutar: (token: string, nuevoInicio?: string) => post(nuevoInicio ? { token, operacion: 'ejecutar', nuevo_inicio: nuevoInicio } : { token, operacion: 'ejecutar' }),
  };
}

const SlotSchema = z.object({ inicio_utc: z.string(), fecha: z.string(), hora_local: z.string() });
const ConsultaSchema = z.object({
  accion: z.enum(['cancelar', 'reprogramar']),
  cita: z.object({ cita_id: z.string(), estado: z.string(), inicio_utc: z.string(), zona_horaria: z.string() }),
  slots: z.array(SlotSchema).max(1000).default([]),
});
export type Consulta = z.output<typeof ConsultaSchema>;
export type SlotGestion = z.output<typeof SlotSchema>;

export const interpretarConsulta = (cuerpo: unknown): Consulta | null => {
  const r = ConsultaSchema.safeParse(cuerpo);
  return r.success === true ? r.data : null;
};

export function agruparSlots(slots: readonly SlotGestion[]): Array<{ fecha: string; etiqueta: string; slots: SlotGestion[] }> {
  const m = new Map<string, SlotGestion[]>();
  for (const s of slots) m.set(s.fecha, [...(m.get(s.fecha) ?? []), s]);
  const fmt = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return [...m].map(([fecha, ss]) => ({ fecha, etiqueta: fmt.format(new Date(`${fecha}T12:00:00Z`)), slots: ss }));
}

export function formatearCita(inicioUtc: string, zona: string): string {
  return new Intl.DateTimeFormat('es-MX', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(inicioUtc));
}

const MENSAJES: Record<string, { titulo: string; mensaje: string }> = {
  TOKEN_VENCIDO: { titulo: 'Este enlace venció', mensaje: 'El enlace para gestionar tu cita ya no está vigente. Escríbenos por WhatsApp si necesitas ayuda.' },
  TOKEN_INVALIDO: { titulo: 'El enlace no es válido', mensaje: 'El enlace está incompleto o fue modificado. Usa el enlace exacto que recibiste por WhatsApp.' },
  SIN_TOKEN: { titulo: 'Falta el enlace de tu cita', mensaje: 'Abre esta página desde el enlace que recibiste por WhatsApp.' },
  NO_ENCONTRADA: { titulo: 'No encontramos tu cita', mensaje: 'Es posible que ya no exista. Escríbenos por WhatsApp si necesitas ayuda.' },
  TRANSICION_INVALIDA: { titulo: 'Tu cita ya no se puede modificar', mensaje: 'Tu cita ya fue cancelada, reprogramada o ya pasó.' },
  FUERA_DE_TIEMPO: { titulo: 'Ya no es posible modificarla', mensaje: 'Tu cita está muy próxima para modificarla en línea. Escríbenos por WhatsApp.' },
  SLOT_LLENO: { titulo: 'Ese horario se acaba de ocupar', mensaje: 'Elige otro horario de la lista.' },
  CUPO_DIARIO: { titulo: 'Ese día ya está lleno', mensaje: 'Elige otro horario de la lista.' },
  SLOT_INVALIDO: { titulo: 'Ese horario ya no está disponible', mensaje: 'Elige otro horario de la lista.' },
  DEMASIADAS_PETICIONES: { titulo: 'Demasiados intentos', mensaje: 'Espera unos minutos e intenta de nuevo.' },
  RED: { titulo: 'Sin conexión', mensaje: 'No pudimos contactar al servidor. Intenta de nuevo o escríbenos por WhatsApp.' },
};
export const mensajeGestion = (codigo: string) => MENSAJES[codigo] ?? { titulo: 'Algo salió mal', mensaje: 'Intenta de nuevo en unos minutos o escríbenos por WhatsApp.' };
