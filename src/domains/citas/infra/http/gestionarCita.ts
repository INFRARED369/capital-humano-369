/**
 * Edge function `gestionar-cita` — POST { token, operacion?: 'consultar' | 'ejecutar', nuevo_inicio? }
 * CIT-11 y C15: la acción (cancelar | reprogramar) y la cita vienen SOLO del token firmado (HMAC + expiración).
 */
import { z } from 'zod';
import { systemClock, type Clock } from '@shared/clock.ts';
import type { Sink } from '@shared/logger.ts';
import type { SqlClient } from '@shared/sql.ts';
import { cancelarCitaCaso, consultarCitaCaso, obtenerSlotsCaso, reprogramarCitaCaso } from '../../application/casosDeUso.ts';
import type { ContactosPort } from '../../application/puertos.ts';
import { verificarLinkGestion } from '../../domain/links.ts';
import { crearRepoSql } from '../sqlCitasRepo.ts';
import { enTransaccion } from '../transaccion.ts';
import { contexto, errorInterno, limitar, origenPermitido, slotPublico, type Contexto, type Origenes } from './comun.ts';
import type { Limitador } from './limitador.ts';

export interface DepsGestionarCita {
  sql: SqlClient;
  /** ALLOWED_ORIGIN (uno o varios). */
  allowedOrigin: Origenes;
  /** LINKS_SECRET */
  secreto: string;
  contactos: ContactosPort;
  clock?: Clock;
  limitador?: Limitador;
  sink?: Sink;
}

const MAX_BYTES = 4096;
const CuerpoSchema = z.strictObject({
  token: z.string().min(1).max(512),
  operacion: z.enum(['consultar', 'ejecutar']).default('ejecutar'),
  nuevo_inicio: z.iso.datetime({ offset: true }).optional(),
});

const STATUS: Record<string, number> = {
  NO_ENCONTRADA: 404,
  TRANSICION_INVALIDA: 409,
  FUERA_DE_TIEMPO: 409,
  SLOT_INVALIDO: 409,
  SLOT_LLENO: 409,
  CUPO_DIARIO: 409,
};
const fallo = (ctx: Contexto, error: string) => ctx.responder({ error }, STATUS[error] ?? 400);

async function leerCuerpo(req: Request, ctx: Contexto): Promise<z.output<typeof CuerpoSchema> | Response> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return ctx.responder({ error: 'TIPO_NO_SOPORTADO' }, 415);
  const texto = await req.text();
  if (new TextEncoder().encode(texto).length > MAX_BYTES) return ctx.responder({ error: 'CUERPO_DEMASIADO_GRANDE' }, 413);
  let datos: unknown;
  try {
    datos = JSON.parse(texto);
  } catch {
    return ctx.responder({ error: 'JSON_INVALIDO' }, 400);
  }
  const r = CuerpoSchema.safeParse(datos);
  return r.success ? r.data : ctx.responder({ error: 'CUERPO_INVALIDO' }, 400);
}

export function crearHandlerGestionarCita(deps: DepsGestionarCita): (req: Request) => Promise<Response> {
  const clock = deps.clock ?? systemClock;
  return async (req) => {
    const ctx = contexto(req, 'gestionar-cita', deps.allowedOrigin, deps.sink);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ctx.headers });
    if (req.method !== 'POST') return ctx.responder({ error: 'METODO_NO_PERMITIDO' }, 405, { allow: 'POST, OPTIONS' });
    if (!origenPermitido(req, deps.allowedOrigin)) return ctx.responder({ error: 'ORIGEN_NO_PERMITIDO' }, 403);
    const limitado = await limitar(req, deps.limitador, ctx);
    if (limitado) return limitado;

    const cuerpo = await leerCuerpo(req, ctx);
    if (cuerpo instanceof Response) return cuerpo;

    const link = await verificarLinkGestion(cuerpo.token, deps.secreto, clock);
    if (!link.ok) {
      ctx.log.warn('link de gestión rechazado', { motivo: link.error });
      return ctx.responder({ error: link.error }, 401);
    }
    const { citaId, accion } = link.value;

    try {
      if (cuerpo.operacion === 'consultar') {
        const repo = crearRepoSql(deps.sql);
        const c = await consultarCitaCaso(repo, citaId);
        if (!c.ok) return fallo(ctx, c.error);
        const cita = {
          cita_id: c.value.citaId,
          vacante_id: c.value.vacanteId,
          estado: c.value.estado,
          inicio_utc: c.value.inicio,
          fin_utc: c.value.fin,
          inicio_local: c.value.inicioLocal,
          zona_horaria: c.value.zonaHoraria,
        };
        if (accion !== 'reprogramar' || c.value.estado !== 'confirmada') return ctx.responder({ accion, cita });
        const s = await obtenerSlotsCaso(repo, clock, c.value.vacanteId);
        const slots = s.ok ? s.value.slots.filter((x) => x.inicio !== c.value.inicio).map(slotPublico) : [];
        return ctx.responder({ accion, cita, slots });
      }

      if (accion === 'cancelar') {
        const r = await enTransaccion(deps.sql, (tx) => cancelarCitaCaso(crearRepoSql(tx), { citaId, motivo: 'candidato' }, clock));
        if (!r.ok) return fallo(ctx, r.error);
        ctx.log.info('cita cancelada por el candidato', { cita_id: citaId });
        return ctx.responder({ accion, cita_id: citaId, estado: 'cancelada' });
      }

      if (!cuerpo.nuevo_inicio) return ctx.responder({ error: 'NUEVO_INICIO_REQUERIDO' }, 400);
      const nuevoInicio = cuerpo.nuevo_inicio;
      const r = await enTransaccion(deps.sql, (tx) => reprogramarCitaCaso(crearRepoSql(tx), deps.contactos, { citaId, nuevoInicio }, clock));
      if (!r.ok) return fallo(ctx, r.error);
      ctx.log.info('cita reprogramada por el candidato', { cita_id: citaId, nueva_cita_id: r.value.citaId });
      return ctx.responder({ accion, cita_id: r.value.citaId, cita_anterior_id: citaId, estado: 'confirmada', inicio_utc: r.value.inicio, fin_utc: r.value.fin });
    } catch (e) {
      return errorInterno(ctx, e);
    }
  };
}
