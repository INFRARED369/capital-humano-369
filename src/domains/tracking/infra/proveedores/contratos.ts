/**
 * Contratos (Zod) de los payloads hacia Meta CAPI y GA4 Measurement Protocol, con fixtures en ./fixtures.
 * Se validan ANTES de enviar: garantizan que la PII solo viaja hasheada (64 hex) y que custom_data
 * lleva client_id (TRK-08, T5).
 */
import { z } from 'zod';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const hashes = z.array(sha256).min(1).max(10);

export const UserDataMetaSchema = z.strictObject({
  ph: hashes.optional(),
  em: hashes.optional(),
  fn: hashes.optional(),
  external_id: hashes.optional(),
  client_ip_address: z.string().min(2).max(45).optional(),
  client_user_agent: z.string().max(500).optional(),
  fbc: z.string().max(600).optional(),
  fbp: z.string().max(100).optional(),
});

export const EventoMetaSchema = z.strictObject({
  event_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,49}$/),
  event_time: z.number().int().positive(),
  event_id: z.string().min(1).max(64),
  action_source: z.enum(['website', 'system_generated']),
  event_source_url: z.url().optional(),
  user_data: UserDataMetaSchema,
  custom_data: z.object({ client_id: z.string().min(1), vacancy_id: z.string().optional(), content_category: z.string().optional() }).catchall(z.string()),
});

export const MetaCapiRequestSchema = z.strictObject({
  data: z.array(EventoMetaSchema).min(1).max(1000),
  test_event_code: z.string().max(40).optional(),
});

export const MetaCapiRespuestaSchema = z.object({ events_received: z.number().int(), messages: z.array(z.unknown()).optional(), fbtrace_id: z.string().optional() });
export const MetaCapiErrorSchema = z.object({ error: z.object({ message: z.string(), type: z.string().optional(), code: z.number().optional(), fbtrace_id: z.string().optional() }) });

export const Ga4MpRequestSchema = z.strictObject({
  client_id: z.string().min(1).max(100),
  timestamp_micros: z.number().int().positive(),
  events: z.array(z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.string().max(100), z.number()])),
  })).min(1).max(25),
});
