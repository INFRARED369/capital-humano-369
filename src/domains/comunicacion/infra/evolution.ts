/**
 * Adaptador Evolution API v2 (COM-01, COM-08).
 * - Enviar texto:      POST {url}/message/sendText/{instance}       body { number, text }
 * - Existe en WhatsApp: POST {url}/chat/whatsappNumbers/{instance}  body { numbers: [...] }
 * Autenticación por cabecera `apikey`. Fixtures en ./__fixtures__/evolution-*.json.
 */
import { z } from 'zod';
import type { ResultadoEnvio, VerificadorWhatsAppPort, WhatsAppPort } from '../application/puertos.ts';
import { errorHttpConDetalle, exigirHttps, leerJson, postJson } from './http-proveedor.ts';

export const EvolutionSendTextSchema = z.looseObject({
  key: z.looseObject({ id: z.string().min(1), remoteJid: z.string().optional(), fromMe: z.boolean().optional() }),
  status: z.string().optional(),
});

export const EvolutionWhatsappNumbersSchema = z.array(z.looseObject({ exists: z.boolean(), jid: z.string().optional(), number: z.string().optional() }));

export interface EvolutionConfig {
  url: string;
  apiKey: string;
  instancia: string;
}

export function crearEvolutionAdapter(cfg: EvolutionConfig, fetchImpl: typeof fetch): WhatsAppPort & VerificadorWhatsAppPort {
  const base = exigirHttps(cfg.url, 'EVOLUTION_URL');
  if (!cfg.apiKey || !cfg.instancia) throw new Error('Evolution: falta EVOLUTION_API_KEY o EVOLUTION_INSTANCE');
  const instancia = encodeURIComponent(cfg.instancia);
  const headers = { apikey: cfg.apiKey };

  return {
    proveedor: 'evolution',

    async enviarTexto(telefonoE164, texto): Promise<ResultadoEnvio> {
      const r = await postJson(fetchImpl, `${base}/message/sendText/${instancia}`, headers, { number: telefonoE164, text: texto });
      if (!r) return { ok: false, error: { motivo: 'RED', permanente: false } };
      if (!r.ok) return { ok: false, error: await errorHttpConDetalle(r) };
      const body = EvolutionSendTextSchema.safeParse(await leerJson(r));
      if (!body.success) return { ok: false, error: { motivo: 'CONTRATO_INVALIDO', permanente: false } };
      // Evolution (Baileys) no cobra por mensaje: el costo lo pone la tarifa configurada del canal.
      return { ok: true, value: { proveedorId: body.data.key.id } };
    },

    async existeEnWhatsApp(telefonoE164) {
      const r = await postJson(fetchImpl, `${base}/chat/whatsappNumbers/${instancia}`, headers, { numbers: [telefonoE164] });
      if (!r) throw new Error('EVOLUTION_RED');
      if (!r.ok) throw new Error(`EVOLUTION_HTTP_${r.status}`);
      const body = EvolutionWhatsappNumbersSchema.safeParse(await leerJson(r));
      if (!body.success) throw new Error('EVOLUTION_CONTRATO_INVALIDO');
      // Se consulta un solo número: Evolution responde una entrada por número pedido.
      return body.data.some((n) => n.exists);
    },
  };
}
