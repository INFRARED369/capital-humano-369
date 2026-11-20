/**
 * Handler puro de la edge function `arco` (PRV-02). POST JSON con `accion`:
 *   registrar  { tipo, canal, telefono? | lead_id?, recibida_en?, ejecutar? }  → 201
 *   ejecutar   { solicitud_id }                                               → 200
 *   responder  { solicitud_id, resultado: 'respondida'|'rechazada', motivo }  → 200
 *   consultar  { solicitud_id } · listar { estado? }                          → 200
 * Nunca devuelve ni registra el teléfono ni su HMAC (R8). Los errores no hacen eco de la entrada.
 */
import { z } from 'zod';
import { json } from '@shared/http.ts';
import type { Logger } from '@shared/logger.ts';
import { CANALES_ARCO, ESTADOS_ARCO, TIPOS_ARCO } from '../../domain/arco.ts';
import type { DepsPrivacidad } from '../../application/puertos.ts';
import { consultarSolicitudArco, ejecutarSolicitudArco, listarSolicitudesArco, registrarSolicitudArco, responderSolicitudArco } from '../../application/arco.ts';
import type { Autenticado, FallaAuth } from './autenticacion.ts';

const MAX_CUERPO = 4096;
const uuid = z.string().uuid();
const Peticion = z.discriminatedUnion('accion', [
  z.strictObject({
    accion: z.literal('registrar'),
    tipo: z.enum(TIPOS_ARCO),
    canal: z.enum(CANALES_ARCO),
    telefono: z.string().min(8).max(20).optional(),
    lead_id: uuid.optional(),
    recibida_en: z.string().datetime({ offset: true }).optional(),
    ejecutar: z.boolean().optional(),
  }),
  z.strictObject({ accion: z.literal('ejecutar'), solicitud_id: uuid }),
  z.strictObject({ accion: z.literal('responder'), solicitud_id: uuid, resultado: z.enum(['respondida', 'rechazada']), motivo: z.string().regex(/^[a-z0-9_]{1,40}$/) }),
  z.strictObject({ accion: z.literal('consultar'), solicitud_id: uuid }),
  z.strictObject({ accion: z.literal('listar'), estado: z.enum(ESTADOS_ARCO).optional() }),
]);

export interface DepsHandlerArco {
  autenticar: (req: Request) => Promise<Autenticado | FallaAuth>;
  privacidad: DepsPrivacidad;
  log: Logger;
}

const ESTADO_HTTP: Record<string, number> = {
  NO_ENCONTRADA: 404, TRANSICION_INVALIDA: 409, TIPO_NO_EJECUTABLE: 409,
  SIN_IDENTIFICADOR: 400, TELEFONO_INVALIDO: 400, LEAD_INVALIDO: 400, FECHA_INVALIDA: 400,
};
const AUTH_HTTP: Record<FallaAuth, number> = { NO_AUTENTICADO: 401, PROHIBIDO: 403, MFA_REQUERIDA: 403 };
const fallo = (e: string) => json({ error: e }, ESTADO_HTTP[e] ?? 400);

export function crearHandlerArco(deps: DepsHandlerArco): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json({ error: 'METODO' }, 405, { allow: 'POST' });
    const quien = await deps.autenticar(req);
    if (typeof quien === 'string') {
      deps.log.warn('arco_acceso_denegado', { motivo: quien });
      return json({ error: quien }, AUTH_HTTP[quien]);
    }
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'CONTENT_TYPE' }, 415);
    if (Number(req.headers.get('content-length') ?? 0) > MAX_CUERPO) return json({ error: 'CUERPO_GRANDE' }, 413);
    const texto = await req.text();
    if (texto.length > MAX_CUERPO) return json({ error: 'CUERPO_GRANDE' }, 413);
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      return json({ error: 'JSON_INVALIDO' }, 400);
    }
    const p = Peticion.safeParse(cuerpo);
    if (!p.success) return json({ error: 'ENTRADA_INVALIDA', campos: [...new Set(p.error.issues.map((i) => String(i.path[0] ?? '')))] }, 400);

    const d = { ...deps.privacidad, logger: deps.log.child({ actor: quien.tipo === 'admin' ? quien.userId : 'servicio' }) };
    const b = p.data;
    switch (b.accion) {
      case 'registrar': {
        const r = await registrarSolicitudArco(d, {
          tipo: b.tipo, canal: b.canal, telefono: b.telefono, leadId: b.lead_id, recibidaEn: b.recibida_en, ejecutar: b.ejecutar,
          creadoPor: quien.tipo === 'admin' ? quien.userId : null,
        });
        if (!r.ok) return fallo(r.error);
        return json({
          solicitud_id: r.value.solicitudId, limite_respuesta: r.value.limiteRespuesta, limite_ejecucion: r.value.limiteEjecucion,
          leads: r.value.leads, ejecucion: r.value.ejecucion,
        }, 201);
      }
      case 'ejecutar': {
        const r = await ejecutarSolicitudArco(d, b.solicitud_id);
        return r.ok ? json({ ok: true, ...r.value }) : fallo(r.error);
      }
      case 'responder': {
        const r = await responderSolicitudArco(d, b.solicitud_id, b.resultado, b.motivo);
        return r.ok ? json({ ok: true }) : fallo(r.error);
      }
      case 'consultar': {
        const r = await consultarSolicitudArco(d, b.solicitud_id);
        return r.ok ? json(r.value) : fallo(r.error);
      }
      case 'listar':
        return json({ solicitudes: await listarSolicitudesArco(d, { estado: b.estado }) });
    }
  };
}
