/**
 * Adaptador MetaCapiPort. D10: UN solo pixel_id para todo el proyecto (META_PIXEL_ID).
 * Modos:
 *  - Stape/GTM server-side (STAPE_URL definido): POST {STAPE_URL}/data (Data Client) con { event_name: 'meta_capi', pixel_id, data }.
 *    El contenedor GTM SS reenvía a CAPI con su propio token.
 *  - Directo: POST https://graph.facebook.com/{version}/{PIXEL_ID}/events con access_token en el cuerpo (no en la URL → no queda en logs).
 */
import { err, ok } from '@shared/result.ts';
import type { MetaCapiPort } from '../../application/puertos.ts';
import { MetaCapiRequestSchema, MetaCapiRespuestaSchema } from './contratos.ts';
import { postJson, type FetchLike } from './http-proveedor.ts';

export interface ConfigMetaCapi { pixelId: string; token?: string; stapeUrl?: string; version?: string }

export function crearMetaCapiAdapter(cfg: ConfigMetaCapi, fetchImpl: FetchLike = (u, i) => fetch(u, i)): MetaCapiPort {
  if (!/^\d{5,20}$/.test(cfg.pixelId)) throw new Error('META_PIXEL_ID inválido');
  if (!cfg.stapeUrl && !cfg.token) throw new Error('Falta META_CAPI_TOKEN o STAPE_URL');
  const version = cfg.version ?? 'v21.0';
  return {
    async enviar(req) {
      const valido = MetaCapiRequestSchema.safeParse(req);
      if (!valido.success) return err({ reintentable: false, mensaje: 'payload fuera de contrato' });
      const [url, cuerpo] = cfg.stapeUrl
        ? [`${cfg.stapeUrl.replace(/\/$/, '')}/data`, { event_name: 'meta_capi', pixel_id: cfg.pixelId, ...valido.data }]
        : [`https://graph.facebook.com/${version}/${cfg.pixelId}/events`, { ...valido.data, access_token: cfg.token }];
      const r = await postJson(fetchImpl, url, cuerpo);
      if (!r.ok) return r;
      if (cfg.stapeUrl) return ok({ eventosRecibidos: valido.data.data.length });
      const parsed = MetaCapiRespuestaSchema.safeParse(await r.value.json().catch(() => null));
      return parsed.success ? ok({ eventosRecibidos: parsed.data.events_received }) : err({ reintentable: true, mensaje: 'respuesta fuera de contrato' });
    },
  };
}
