/**
 * Handlers puros (Request → Response) de las edge functions zoho-sync-worker y
 * zoho-reconciliacion (CONTRATOS §6). El cableado Deno vive en supabase/functions/<fn>/index.ts.
 * Las invoca el cron (pg_cron + pg_net) con `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`.
 */
import { json } from '@shared/http.ts';
import { timingSafeEqual } from '@shared/crypto.ts';
import { err, ok, type Result } from '@shared/result.ts';
import type { Logger } from '@shared/logger.ts';
import { dominiosZoho, type ZohoConfig } from '../zohoCalendarAdapter.ts';

export interface ConfigZohoEntorno {
  zoho: ZohoConfig;
  panelUrl: string;
  zonaHoraria: string;
  secretoCron: string;
}

type Env = Record<string, string | undefined>;

function urlPanelValida(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

function dcValido(v: string): boolean {
  try {
    dominiosZoho(v);
    return true;
  } catch {
    return false;
  }
}

/** Lee la configuración SOLO del entorno. En error devuelve los NOMBRES de las variables inválidas (nunca valores). */
export function leerConfigZoho(env: Env): Result<ConfigZohoEntorno, string[]> {
  const v = (k: string) => (env[k] ?? '').trim();
  // ZOHO_CRON_SECRET (opcional) tiene prioridad: en proyectos con llaves nuevas, la SUPABASE_SERVICE_ROLE_KEY
  // que inyecta Supabase no es la llave legacy que manda pg_cron desde Vault (runbook §2).
  const secretoCron = v('ZOHO_CRON_SECRET') || v('SUPABASE_SERVICE_ROLE_KEY');
  const reglas: Array<[string, (x: string) => boolean]> = [
    ['ZOHO_CLIENT_ID', Boolean],
    ['ZOHO_CLIENT_SECRET', Boolean],
    ['ZOHO_REFRESH_TOKEN', Boolean],
    ['ZOHO_DC', dcValido],
    ['PANEL_URL', urlPanelValida],
  ];
  const malas = reglas.filter(([k, valida]) => !valida(v(k))).map(([k]) => k);
  if (!secretoCron) malas.push('SUPABASE_SERVICE_ROLE_KEY');
  if (malas.length > 0) return err(malas);
  return ok({
    zoho: { dc: v('ZOHO_DC'), clientId: v('ZOHO_CLIENT_ID'), clientSecret: v('ZOHO_CLIENT_SECRET'), refreshToken: v('ZOHO_REFRESH_TOKEN') },
    panelUrl: v('PANEL_URL').replace(/\/+$/, ''),
    zonaHoraria: v('ZOHO_TZ') || 'America/Mexico_City',
    secretoCron,
  });
}

export function verificarBearer(req: Request, secreto: string): boolean {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return !!secreto && !!m && timingSafeEqual(m[1]!, secreto);
}

export interface HandlerCronDeps {
  nombre: 'zoho-sync-worker' | 'zoho-reconciliacion';
  secreto: string;
  logger: Logger;
  ejecutar: () => Promise<unknown>;
}

export function crearHandlerCronZoho(d: HandlerCronDeps): (req: Request) => Promise<Response> {
  const log = d.logger.child({ fn: d.nombre });
  return async (req) => {
    if (req.method !== 'POST') return json({ error: 'metodo_no_permitido' }, 405, { allow: 'POST' });
    if (!verificarBearer(req, d.secreto)) return json({ error: 'no_autorizado' }, 401);
    try {
      const resumen = await d.ejecutar();
      log.info('zoho: corrida terminada', { resumen });
      return json({ ok: true, resumen });
    } catch (e) {
      log.error('zoho: corrida fallida', { error: (e as Error).message });
      return json({ ok: false, error: 'interno' }, 500);
    }
  };
}
