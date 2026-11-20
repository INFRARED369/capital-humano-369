import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// D5: export 100 % estático; todo lo dinámico vive en edge functions de Supabase.
const config: NextConfig = {
  output: 'export',
  trailingSlash: true, // mantiene /vacantes/agente-smart/ (CAP-01)
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
};
export default config;
