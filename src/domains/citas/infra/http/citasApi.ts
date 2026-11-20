/**
 * Edge function `citas-api` — GET /citas-api?vacante=<slug|uuid> (F1.6, C9, NFR-ESC-05).
 * Handler puro: supabase/functions/citas-api/index.ts solo arma las dependencias.
 */
import { z } from 'zod';
import { systemClock, type Clock } from '@shared/clock.ts';
import type { Sink } from '@shared/logger.ts';
import type { SqlClient } from '@shared/sql.ts';
import { obtenerSlotsCaso } from '../../application/casosDeUso.ts';
import { crearRepoSql } from '../sqlCitasRepo.ts';
import { contexto, errorInterno, limitar, origenPermitido, slotPublico, type Origenes } from './comun.ts';
import type { Limitador } from './limitador.ts';

export interface DepsCitasApi {
  sql: SqlClient;
  /** ALLOWED_ORIGIN (uno o varios). */
  allowedOrigin: Origenes;
  clock?: Clock;
  limitador?: Limitador;
  sink?: Sink;
}

const ConsultaSchema = z.strictObject({
  vacante: z.union([z.uuid(), z.string().max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)]),
});

export function crearHandlerCitasApi(deps: DepsCitasApi): (req: Request) => Promise<Response> {
  const clock = deps.clock ?? systemClock;
  return async (req) => {
    const ctx = contexto(req, 'citas-api', deps.allowedOrigin, deps.sink);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ctx.headers });
    if (req.method !== 'GET') return ctx.responder({ error: 'METODO_NO_PERMITIDO' }, 405, { allow: 'GET, OPTIONS' });
    if (!origenPermitido(req, deps.allowedOrigin)) return ctx.responder({ error: 'ORIGEN_NO_PERMITIDO' }, 403);
    const limitado = await limitar(req, deps.limitador, ctx);
    if (limitado) return limitado;

    const consulta = ConsultaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!consulta.success) return ctx.responder({ error: 'CONSULTA_INVALIDA' }, 400);

    try {
      const r = await obtenerSlotsCaso(crearRepoSql(deps.sql), clock, consulta.data.vacante);
      if (!r.ok) return ctx.responder({ error: r.error }, 404);
      return ctx.responder(
        {
          vacante_id: r.value.vacanteId,
          // F7.4: 'whatsapp' → slots vacío a propósito; la landing ofrece el flujo de WhatsApp.
          agenda_modo: r.value.agendaModo,
          zona_horaria: r.value.zonaHoraria,
          reglas_version: r.value.reglasVersion,
          slots: r.value.slots.map(slotPublico),
        },
        200,
        // La disponibilidad cambia con cada reserva: caché corta; la reserva revalida bajo lock.
        { 'cache-control': 'public, max-age=10' },
      );
    } catch (e) {
      return errorInterno(ctx, e);
    }
  };
}
