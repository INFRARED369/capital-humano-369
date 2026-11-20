/** TRK-06 · Caso de uso de la ingesta server-side de eventos del navegador. */
import { err, ok, type Result } from '@shared/result.ts';
import { redactar } from '@shared/logger.ts';
import { clasificarOrigen, hostDe } from '../domain/origen.ts';
import { destinosDe } from '../domain/eventos.ts';
import { esIpValida } from '../domain/ip.ts';
import { sanearSegunConsentimiento } from '../domain/consentimiento.ts';
import { EventoNavegadorSchema } from '../domain/ingesta.ts';
import type { Geo, RepoTracking } from './puertos.ts';

export type { Geo };
export interface EntradaIngesta { cuerpo: unknown; ip: string | null; userAgent: string | null; geo: Geo }
export type ResultadoIngesta = Result<{ registro: 'evento' | 'duplicado' | 'anonimo' }, 'INVALIDO'>;

const corta = (s: string | null | undefined, max: number): string | null => (s ? s.slice(0, max) : null);

function normalizarIp(ip: string | null): string | null {
  if (!ip) return null;
  const v = /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip;
  return esIpValida(v) ? v : null;
}

export async function ingerirEvento(deps: { repo: RepoTracking; hostPropio?: string }, entrada: EntradaIngesta): Promise<ResultadoIngesta> {
  const parsed = EventoNavegadorSchema.safeParse(entrada.cuerpo);
  if (!parsed.success) return err('INVALIDO');
  const e = parsed.data;
  const atr = e.atribucion ?? {};
  const fbclid = 'fbclid' in atr ? atr.fbclid : 'tiene_fbclid' in atr ? atr.tiene_fbclid : undefined;
  const gclid = 'gclid' in atr ? atr.gclid : 'tiene_gclid' in atr ? atr.tiene_gclid : undefined;
  const origen = clasificarOrigen({ utm_source: atr.utm_source, utm_medium: atr.utm_medium, fbclid, gclid, referrer: e.referrer, hostPropio: deps.hostPropio });
  const vacante_ref = e.custom_data?.vacancy_id ?? null;
  // TRK-08: el client_id del navegador NO se usa (el JSON de contenido trae texto, y no es confiable):
  // el servidor lo deriva de la vacante (shared.api_vacante_por_slug).
  const cliente_ref = null;

  if (!e.consentimiento) {
    await deps.repo.contarAnonimo({ nombre: e.nombre, vacante_ref, cliente_ref, origen, utm_source: atr.utm_source ?? null, utm_campaign: atr.utm_campaign ?? null });
    return ok({ registro: 'anonimo' });
  }

  const ids = sanearSegunConsentimiento({
    consentimiento: true,
    visitorId: e.visitor_id,
    ip: normalizarIp(entrada.ip),
    userAgent: corta(entrada.userAgent, 500),
    fbc: 'fbc' in atr ? (atr.fbc ?? null) : null,
    fbp: 'fbp' in atr ? (atr.fbp ?? null) : null,
    gclid: typeof gclid === 'string' ? gclid : null,
    fbclid: typeof fbclid === 'string' ? fbclid : null,
  });
  const props = (redactar(e.props ?? {}) ?? {}) as Record<string, unknown>;
  const destinos = destinosDe(e.nombre, props, { consentimiento: true, origen: 'navegador' });
  const { duplicado } = await deps.repo.registrarEvento(
    {
      event_id: e.event_id,
      nombre: e.nombre,
      fuente: 'navegador',
      consentimiento: true,
      origen,
      visitor_id: ids.visitorId,
      vacante_ref,
      cliente_ref,
      content_category: e.custom_data?.content_category ?? null,
      utm_source: atr.utm_source ?? null,
      utm_medium: atr.utm_medium ?? null,
      utm_campaign: atr.utm_campaign ?? null,
      utm_content: atr.utm_content ?? null,
      utm_term: atr.utm_term ?? null,
      gclid: ids.gclid,
      fbc: ids.fbc,
      fbp: ids.fbp,
      referrer_host: hostDe(e.referrer),
      pagina: e.pagina ?? null,
      ip: ids.ip,
      ciudad: corta(entrada.geo.ciudad, 100),
      region: corta(entrada.geo.region, 100),
      pais: entrada.geo.pais && /^[A-Za-z]{2}$/.test(entrada.geo.pais) ? entrada.geo.pais.toUpperCase() : null,
      user_agent: ids.userAgent,
      propiedades: props,
    },
    destinos,
  );
  return ok({ registro: duplicado ? 'duplicado' : 'evento' });
}
