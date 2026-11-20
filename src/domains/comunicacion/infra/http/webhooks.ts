/**
 * Handlers puros de webhook-evolution y webhook-nbx (NFR-SEG-05, M5).
 * Autenticación (una de dos):
 *  - Firma HMAC: `x-369-signature: sha256=<hex>` y `x-369-timestamp: <epoch s>` sobre `${ts}.${cuerpo}` (NBX / relay).
 *  - Token (solo con `aceptarToken`, Evolution v2 que no firma): `x-369-webhook-token` configurado en
 *    `webhook.headers` de la instancia, comparado en tiempo constante, MÁS frescura del `date_time` del cuerpo.
 * Anti-replay: id del evento del proveedor (o sha256 del cuerpo) único en comunicacion.webhooks_vistos.
 * COM-07: el webhook nunca responde al candidato; solo actualiza entrega y registra bajas.
 */
import { z } from 'zod';
import type { Clock } from '@shared/clock.ts';
import { sha256Hex } from '@shared/crypto.ts';
import { correlationId, json } from '@shared/http.ts';
import type { Logger } from '@shared/logger.ts';
import type { SqlClient } from '@shared/sql.ts';
import { idEventoEvolution, verificarFrescura, verificarTokenWebhook, verificarWebhook } from '../../domain/webhook.ts';
import { registrarOptOut } from '../../application/privacidad.ts';

export type ProveedorWebhook = 'evolution' | 'nbx';
type EstadoEntrega = 'entregado' | 'leido' | 'fallido';

export interface DepsWebhook {
  sql: SqlClient;
  clock: Clock;
  /** EVOLUTION_WEBHOOK_SECRET / NBX_WEBHOOK_SECRET */
  secreto: string;
  /** HMAC_PEPPER (opt-out por "BAJA") */
  pepper: string;
  logger: Logger;
  /** Acepta `x-369-webhook-token` (= secreto) cuando no viene firma HMAC. Solo Evolution v2. */
  aceptarToken?: boolean;
  /** Desfase UTC (min) con el que Evolution escribe `date_time` (CDMX = -360; 0 si corre en UTC). */
  desfaseMin?: number;
  /** Tolerancia de frescura (s), por defecto 300. */
  toleranciaSeg?: number;
}

const MAX_CUERPO = 64 * 1024;
const RE_BAJA = /^\s*(baja|stop|alto|cancelar|no más mensajes|no mas mensajes)\s*[.!]?\s*$/i;

const EvolutionEventoSchema = z.looseObject({ event: z.string(), data: z.unknown() });
const EvolutionUpdateSchema = z.looseObject({ keyId: z.string().optional(), key: z.looseObject({ id: z.string() }).optional(), status: z.string() });
const EvolutionUpsertSchema = z.looseObject({
  key: z.looseObject({ remoteJid: z.string(), fromMe: z.boolean() }),
  message: z.looseObject({ conversation: z.string().optional(), extendedTextMessage: z.looseObject({ text: z.string() }).optional() }).nullish(),
});
const NbxEventoSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), message_id: z.union([z.string(), z.number()]).optional(), status: z.string() });

const ESTADOS_EVOLUTION: Record<string, EstadoEntrega> = { DELIVERY_ACK: 'entregado', READ: 'leido', PLAYED: 'leido', ERROR: 'fallido' };
const ESTADOS_NBX: Record<string, EstadoEntrega> = { delivered: 'entregado', read: 'leido', failed: 'fallido', undelivered: 'fallido', rejected: 'fallido' };

export function crearHandlerWebhook(proveedor: ProveedorWebhook, deps: DepsWebhook): (req: Request) => Promise<Response> {
  return async (req) => {
    const log = deps.logger.child({ fn: `webhook-${proveedor}`, correlation_id: correlationId(req) });
    if (req.method !== 'POST') return json({ error: 'METODO' }, 405, { allow: 'POST' });
    const cuerpo = await req.text();
    if (cuerpo.length > MAX_CUERPO) return json({ error: 'DEMASIADO_GRANDE' }, 413);

    const rechazar = (motivo: string) => {
      log.warn('webhook rechazado', { motivo, metrica: 'comunicacion.webhook_rechazado' });
      return json({ error: 'NO_AUTORIZADO' }, 401);
    };

    const firmaHeader = req.headers.get('x-369-signature');
    const modoToken = deps.aceptarToken === true && firmaHeader === null;
    if (modoToken) {
      const t = verificarTokenWebhook(deps.secreto, req.headers.get('x-369-webhook-token'));
      if (!t.ok) return rechazar(t.error);
    } else {
      const firma = await verificarWebhook({
        secreto: deps.secreto,
        firma: firmaHeader,
        timestamp: req.headers.get('x-369-timestamp'),
        cuerpo,
        ahora: deps.clock.now(),
        toleranciaSeg: deps.toleranciaSeg,
      });
      if (!firma.ok) return rechazar(firma.error);
    }

    let datos: unknown;
    try {
      datos = JSON.parse(cuerpo);
    } catch {
      return json({ error: 'JSON_INVALIDO' }, 400);
    }
    if (modoToken) {
      const fresco = verificarFrescura((datos as { date_time?: unknown } | null)?.date_time, deps.clock.now(), { toleranciaSeg: deps.toleranciaSeg, desfaseMin: deps.desfaseMin });
      if (!fresco.ok) return rechazar(fresco.error);
    }

    const eventoId = (proveedor === 'evolution' ? idEventoEvolution(datos) : null) ?? (await sha256Hex(cuerpo));
    return deps.sql.transaction(async (tx) => {
      const nuevo = await tx.query(`insert into comunicacion.webhooks_vistos (proveedor, evento_id) values ($1, $2) on conflict do nothing returning 1`, [proveedor, eventoId]);
      if (!nuevo.rows.length) return json({ ok: true, duplicado: true });
      const r = proveedor === 'evolution' ? await procesarEvolution(tx, deps, datos) : await procesarNbx(tx, datos);
      log.info('webhook procesado', { ...r });
      return json({ ok: true, duplicado: false, ...r });
    });
  };
}

async function actualizarEntrega(tx: SqlClient, proveedor: ProveedorWebhook, proveedorId: string, estado: EstadoEntrega): Promise<number> {
  // Solo avanza: entregado (1) < fallido (2) < leido (3).
  const { rows } = await tx.query(
    `update comunicacion.mensajes set estado_entrega = $3, actualizado_en = now()
     where proveedor = $1 and proveedor_id = $2
       and coalesce(array_position(array['entregado','fallido','leido'], estado_entrega), 0) < array_position(array['entregado','fallido','leido'], $3::text)
     returning 1`,
    [proveedor, proveedorId, estado],
  );
  return rows.length;
}

async function procesarEvolution(tx: SqlClient, deps: DepsWebhook, datos: unknown): Promise<{ actualizados: number; opt_out: boolean }> {
  const ev = EvolutionEventoSchema.safeParse(datos);
  if (!ev.success) return { actualizados: 0, opt_out: false };
  const evento = ev.data.event.toLowerCase().replace(/_/g, '.');
  if (evento === 'messages.update') {
    const u = EvolutionUpdateSchema.safeParse(ev.data.data);
    const id = u.success ? (u.data.keyId ?? u.data.key?.id) : undefined;
    const estado = u.success ? ESTADOS_EVOLUTION[u.data.status] : undefined;
    return { actualizados: id && estado ? await actualizarEntrega(tx, 'evolution', id, estado) : 0, opt_out: false };
  }
  if (evento === 'messages.upsert') {
    const m = EvolutionUpsertSchema.safeParse(ev.data.data);
    if (!m.success || m.data.key.fromMe) return { actualizados: 0, opt_out: false };
    const texto = m.data.message?.conversation ?? m.data.message?.extendedTextMessage?.text ?? '';
    if (!RE_BAJA.test(texto)) return { actualizados: 0, opt_out: false };
    const telefono = m.data.key.remoteJid.split('@')[0]!.replace(/\D/g, '');
    if (!telefono) return { actualizados: 0, opt_out: false };
    await registrarOptOut(tx, { telefonoE164: telefono, clienteId: null, origen: 'webhook' }, deps.pepper);
    return { actualizados: 0, opt_out: true };
  }
  return { actualizados: 0, opt_out: false };
}

async function procesarNbx(tx: SqlClient, datos: unknown): Promise<{ actualizados: number; opt_out: boolean }> {
  const ev = NbxEventoSchema.safeParse(datos);
  if (!ev.success) return { actualizados: 0, opt_out: false };
  const id = ev.data.id ?? ev.data.message_id;
  const estado = ESTADOS_NBX[ev.data.status.toLowerCase()];
  return { actualizados: id !== undefined && estado ? await actualizarEntrega(tx, 'nbx', String(id), estado) : 0, opt_out: false };
}
