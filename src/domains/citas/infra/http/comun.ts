/** Piezas comunes de los handlers HTTP de citas (CORS, origen, rate limit, errores). */
import { cors, correlationId, ipCliente, json } from '@shared/http.ts';
import { crearLogger, type Logger, type Sink } from '@shared/logger.ts';
import type { Slot } from '../../domain/slots.ts';
import type { Limitador } from './limitador.ts';

export interface Contexto {
  headers: Record<string, string>;
  log: Logger;
  responder(body: unknown, status?: number, extra?: Record<string, string>): Response;
}

/** ALLOWED_ORIGIN puede ser uno o varios orígenes. */
export type Origenes = string | readonly string[];
const lista = (o: Origenes): readonly string[] => (typeof o === 'string' ? [o] : o);

export function contexto(req: Request, fn: string, origenes: Origenes, sink?: Sink): Contexto {
  const cid = correlationId(req);
  const permitidos = lista(origenes);
  const origen = req.headers.get('origin');
  const eco = origen && permitidos.includes(origen) ? origen : permitidos[0] ?? 'null';
  const headers = { ...cors(eco), 'x-correlation-id': cid };
  const log = crearLogger({ fn, correlation_id: cid }, sink);
  return { headers, log, responder: (body, status = 200, extra = {}) => json(body, status, { ...headers, ...extra }) };
}

/** Rechaza navegadores de otros orígenes; peticiones sin Origin (servidor a servidor) pasan. */
export const origenPermitido = (req: Request, origenes: Origenes): boolean => {
  const o = req.headers.get('origin');
  return !o || lista(origenes).includes(o);
};

export async function limitar(req: Request, limitador: Limitador | undefined, ctx: Contexto): Promise<Response | null> {
  if (!limitador) return null;
  const r = await limitador.permitir(ipCliente(req) ?? 'sin-ip');
  return r.ok ? null : ctx.responder({ error: 'DEMASIADAS_PETICIONES' }, 429, { 'retry-after': String(r.reintentarEnSeg) });
}

export function errorInterno(ctx: Contexto, e: unknown): Response {
  ctx.log.error('error no controlado', { error: e instanceof Error ? e.message : String(e) });
  return ctx.responder({ error: 'ERROR_INTERNO' }, 500);
}

/** Representación pública de un slot: UTC para reservar y hora local de la vacante para mostrar. */
export const slotPublico = (s: Slot) => ({
  inicio_utc: s.inicio,
  fin_utc: s.fin,
  inicio_local: s.inicioLocal,
  fecha: s.fecha,
  hora_local: s.horaLocal,
  disponibles: s.disponibles,
});
