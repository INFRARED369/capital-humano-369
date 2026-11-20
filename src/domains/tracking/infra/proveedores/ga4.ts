/**
 * Adaptador Ga4Port (Measurement Protocol). Vía Stape/GTM SS (cliente "Measurement Protocol (GA4)" en
 * {STAPE_URL}/mp/collect) o directo a google-analytics.com. Sin PII: solo client_id = visitor_id.
 */
import { err, ok } from '@shared/result.ts';
import type { Ga4Port } from '../../application/puertos.ts';
import { Ga4MpRequestSchema } from './contratos.ts';
import { postJson, type FetchLike } from './http-proveedor.ts';

export interface ConfigGa4 { measurementId: string; apiSecret: string; stapeUrl?: string }

export function crearGa4Adapter(cfg: ConfigGa4, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Ga4Port {
  if (!/^G-[A-Z0-9]{4,20}$/.test(cfg.measurementId)) throw new Error('GA4_MEASUREMENT_ID inválido');
  if (!cfg.apiSecret) throw new Error('Falta GA4_API_SECRET');
  const base = cfg.stapeUrl ? `${cfg.stapeUrl.replace(/\/$/, '')}/mp/collect` : 'https://www.google-analytics.com/mp/collect';
  const url = `${base}?measurement_id=${encodeURIComponent(cfg.measurementId)}&api_secret=${encodeURIComponent(cfg.apiSecret)}`;
  return {
    async enviar(req) {
      const valido = Ga4MpRequestSchema.safeParse(req);
      if (!valido.success) return err({ reintentable: false, mensaje: 'payload fuera de contrato' });
      const r = await postJson(fetchImpl, url, valido.data);
      return r.ok ? ok(undefined) : r;
    },
  };
}
