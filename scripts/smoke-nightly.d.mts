export interface ConfigSmoke {
  zoho: { dc: string; clientId: string; clientSecret: string; refreshToken: string };
  calendario: string;
  evolution: { url: string; apiKey: string; instancia: string };
  telefono: string;
  funcionesUrl: string;
  origen: string;
  vacante: string;
  zonaHoraria: string;
}
export interface CheckSmoke { nombre: string; ok: boolean; detalle: string }
export interface ResultadoSmoke { ok: boolean; checks: CheckSmoke[] }
export declare function leerConfig(env: Record<string, string | undefined>): { faltan: string[]; cfg: ConfigSmoke };
export declare function ejecutarSmoke(d: {
  cfg: ConfigSmoke;
  fetch: typeof fetch;
  dominio: { crearZohoCalendarAdapter: unknown; construirEventoMinimo: unknown; crearEvolutionAdapter: unknown };
  ahora?: () => Date;
  codigo?: () => string;
  log?: (s: string) => void;
}): Promise<ResultadoSmoke>;
export declare function resumenMarkdown(r: ResultadoSmoke): string;
