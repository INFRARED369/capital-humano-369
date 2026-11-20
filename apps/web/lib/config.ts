/** Configuración pública (sin secretos: NFR-SEG-02). Se inyecta en build vía NEXT_PUBLIC_*. */
export const configPublica = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  funcionesUrl: process.env.NEXT_PUBLIC_FUNCIONES_URL ?? `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321'}/functions/v1`,
  turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '1x00000000000000000000AA',
  whatsappFallback: process.env.NEXT_PUBLIC_WHATSAPP_FALLBACK ?? '528119942627',
  metaPixelId: process.env.NEXT_PUBLIC_META_PIXEL_ID ?? '',
  ga4Id: process.env.NEXT_PUBLIC_GA4_ID ?? '',
  gtmId: process.env.NEXT_PUBLIC_GTM_ID ?? '',
  clarityId: process.env.NEXT_PUBLIC_CLARITY_ID ?? '',
  versionAviso: process.env.NEXT_PUBLIC_VERSION_AVISO ?? '2026-11-13',
} as const;
