/**
 * Worker de la cola 'tracking-capi' (T5, T7, NFR-ESC-04): arma el payload al enviar (la cola no
 * guarda PII), hashea en servidor, envía a Meta CAPI / GA4 y reintenta con backoff exponencial.
 * Si el evento crudo ya no existe (suprimido/retención) o el lead fue suprimido, se completa sin enviar.
 */
import { construirEventoGa4, construirEventoMeta } from '../domain/capi.ts';
import { eventoGa4, eventoMeta, type EventoFunnel } from '../domain/eventos.ts';
import type { ColaPort, ContactosPort, EventoGuardado, Ga4Port, Logger, MensajeCola, MetaCapiPort, RepoTracking } from './puertos.ts';

export interface DepsWorkerCapi {
  cola: ColaPort;
  repo: RepoTracking;
  meta: MetaCapiPort;
  ga4: Ga4Port;
  contactos: ContactosPort;
  config: { sitioUrl: string; testEventCode?: string };
  log: Logger;
}

export interface ResumenWorker { enviados: number; reintentos: number; deadLetters: number; omitidos: number }

export const backoffSeg = (intento: number): number => Math.min(30 * 2 ** Math.max(intento - 1, 0), 3600);

type Salida = { tipo: 'enviado' } | { tipo: 'omitido'; motivo: string } | { tipo: 'error'; mensaje: string };

const customData = (ev: EventoGuardado) => ({ vacancy_id: ev.vacanteId, client_id: ev.clienteId, content_category: ev.contentCategory });

async function enviarMeta(deps: DepsWorkerCapi, ev: EventoGuardado): Promise<Salida> {
  const mapeo = eventoMeta(ev.nombre as EventoFunnel, ev.propiedades);
  if (!mapeo) return { tipo: 'omitido', motivo: 'sin_mapeo_meta' };
  const contacto = ev.leadId ? await deps.contactos.obtener(ev.leadId) : null;
  if (ev.leadId && !contacto) return { tipo: 'omitido', motivo: 'lead_suprimido' };
  const ctx = ev.visitorId && ev.fuente === 'servidor' ? await deps.repo.contextoVisitante(ev.visitorId) : null;
  const visitante = ev.visitorId
    ? { visitorId: ev.visitorId, ip: ev.ip ?? ctx?.ip ?? null, userAgent: ev.userAgent ?? ctx?.userAgent ?? null, fbc: ev.fbc ?? ctx?.fbc ?? null, fbp: ev.fbp ?? ctx?.fbp ?? null }
    : null;
  const pagina = ev.pagina ?? ctx?.pagina ?? null;
  const evento = await construirEventoMeta({
    eventId: ev.eventId,
    nombreMeta: mapeo.nombre,
    actionSource: mapeo.actionSource,
    ocurridoEn: ev.creadoEn,
    urlOrigen: pagina ? `${deps.config.sitioUrl.replace(/\/$/, '')}${pagina}` : null,
    customData: customData(ev),
    contacto: contacto ? { telefono: contacto.telefonoE164, email: contacto.email, nombrePila: contacto.nombrePila } : null,
    visitante,
  });
  const r = await deps.meta.enviar({ data: [evento], ...(deps.config.testEventCode ? { test_event_code: deps.config.testEventCode } : {}) });
  return r.ok ? { tipo: 'enviado' } : { tipo: 'error', mensaje: `meta ${r.error.status ?? ''} ${r.error.mensaje}`.trim() };
}

async function enviarGa4(deps: DepsWorkerCapi, ev: EventoGuardado): Promise<Salida> {
  const nombre = eventoGa4(ev.nombre as EventoFunnel);
  if (!nombre) return { tipo: 'omitido', motivo: 'sin_mapeo_ga4' };
  if (!ev.visitorId) return { tipo: 'omitido', motivo: 'sin_visitante' };
  const r = await deps.ga4.enviar(construirEventoGa4({ nombre, clientId: ev.visitorId, eventId: ev.eventId, ocurridoEn: ev.creadoEn, customData: customData(ev) }));
  return r.ok ? { tipo: 'enviado' } : { tipo: 'error', mensaje: `ga4 ${r.error.status ?? ''} ${r.error.mensaje}`.trim() };
}

async function procesar(deps: DepsWorkerCapi, m: MensajeCola): Promise<Salida> {
  try {
    const ev = await deps.repo.obtenerEvento(m.payload.event_id);
    if (!ev) return { tipo: 'omitido', motivo: 'evento_inexistente' };
    return m.payload.destino === 'meta' ? await enviarMeta(deps, ev) : await enviarGa4(deps, ev);
  } catch (e) {
    return { tipo: 'error', mensaje: (e as Error).message };
  }
}

export async function procesarColaCapi(deps: DepsWorkerCapi, n = 50, vtSeg = 120): Promise<ResumenWorker> {
  const resumen: ResumenWorker = { enviados: 0, reintentos: 0, deadLetters: 0, omitidos: 0 };
  for (const m of await deps.cola.tomar(n, vtSeg)) {
    const s = await procesar(deps, m);
    const log = deps.log.child({ cola_id: m.id, event_id: m.payload.event_id, destino: m.payload.destino, intento: m.intentos });
    if (s.tipo === 'error') {
      const r = await deps.cola.fallar(m.id, s.mensaje, backoffSeg(m.intentos));
      if (r === 'dead_letter') {
        resumen.deadLetters++;
        log.error('tracking-capi: dead letter', { error: s.mensaje });
      } else {
        resumen.reintentos++;
        log.warn('tracking-capi: reintento', { error: s.mensaje });
      }
      continue;
    }
    await deps.cola.completar(m.id);
    if (s.tipo === 'enviado') resumen.enviados++;
    else {
      resumen.omitidos++;
      log.info('tracking-capi: omitido', { motivo: s.motivo });
    }
  }
  return resumen;
}
