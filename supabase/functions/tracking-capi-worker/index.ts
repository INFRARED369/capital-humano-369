/**
 * tracking-capi-worker (cron cada minuto): outbox (consumidor 'tracking') → cola tracking-capi → Meta CAPI / GA4.
 * Autenticación: el cron de plataforma llama con `Authorization: Bearer <service_role_key>`;
 * el handler compara en tiempo constante con SUPABASE_SERVICE_ROLE_KEY (inyectada por Supabase).
 * Modo de envío: STAPE_URL (GTM server-side) si existe; si no, directo con META_CAPI_TOKEN / GA4_API_SECRET.
 * TRK-07: con GEOIP_URL (plantilla https con {ip}) completa ciudad/región/país de los eventos sin dato del CDN,
 * de forma asíncrona y consultando la red /24 (nunca la IP completa). Sin GEOIP_URL no hace nada.
 */
import { entornoDeno, sqlDeno } from '../_shared/index.ts';
import { crearLogger } from '@shared/logger.ts';
import { obtenerContactoLead } from '@domains/captacion/index.ts';
import {
  correrTrabajoTracking, crearContactosDesdeCaptacion, crearGa4Adapter, crearGeoIpDesdeEntorno, crearHandlerWorker, crearMetaCapiAdapter,
} from '@domains/tracking/index.ts';

const env = entornoDeno(['SUPABASE_DB_URL', 'META_PIXEL_ID', 'GA4_API_SECRET', 'ALLOWED_ORIGIN']);
const opc = Deno.env.toObject();
const stapeUrl = opc.STAPE_URL || undefined;
const log = crearLogger({ funcion: 'tracking-capi-worker' });
const sql = sqlDeno(env.SUPABASE_DB_URL);

const meta = crearMetaCapiAdapter({ pixelId: env.META_PIXEL_ID, token: opc.META_CAPI_TOKEN || undefined, stapeUrl });
const ga4 = crearGa4Adapter({ measurementId: opc.GA4_MEASUREMENT_ID ?? '', apiSecret: env.GA4_API_SECRET, stapeUrl });
const geoIp = opc.GEOIP_URL ? crearGeoIpDesdeEntorno(opc, fetch) : undefined;

Deno.serve(crearHandlerWorker({
  secreto: opc.TRACKING_WORKER_SECRET || opc.SUPABASE_SERVICE_ROLE_KEY || '',
  log,
  correr: () => correrTrabajoTracking({
    sql,
    meta,
    ga4,
    contactos: crearContactosDesdeCaptacion(obtenerContactoLead, sql),
    config: { sitioUrl: env.ALLOWED_ORIGIN[0]!, testEventCode: opc.META_TEST_EVENT_CODE || undefined, capiSinCookies: opc.TRACKING_CAPI_SIN_COOKIES === 'true' },
    log,
    geoIp,
  }),
}));
