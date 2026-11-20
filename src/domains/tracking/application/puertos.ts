/** Puertos del dominio tracking (implementados en infra/ o por otros dominios). */
import type { Result } from '@shared/result.ts';
import type { Logger } from '@shared/logger.ts';
import type { Destino } from '../domain/eventos.ts';
import type { EventoGa4Mp, MetaCapiRequest } from '../domain/capi.ts';

export interface EventoRegistrable {
  event_id: string;
  nombre: string;
  fuente: 'navegador' | 'servidor';
  consentimiento: boolean;
  origen: string;
  visitor_id?: string | null;
  lead_id?: string | null;
  vacante_ref?: string | null;
  cliente_ref?: string | null;
  content_category?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  gclid?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  referrer_host?: string | null;
  pagina?: string | null;
  ip?: string | null;
  ciudad?: string | null;
  region?: string | null;
  pais?: string | null;
  user_agent?: string | null;
  propiedades?: Record<string, unknown>;
}

export interface ConteoAnonimo { nombre: string; vacante_ref: string | null; cliente_ref: string | null; origen: string; utm_source: string | null; utm_campaign: string | null }

export interface EventoGuardado {
  eventId: string; nombre: string; fuente: 'navegador' | 'servidor'; creadoEn: Date;
  visitorId: string | null; leadId: string | null; vacanteId: string | null; clienteId: string; contentCategory: string | null;
  pagina: string | null; ip: string | null; userAgent: string | null; fbc: string | null; fbp: string | null; propiedades: Record<string, unknown>;
}

export interface ContextoVisitanteGuardado {
  ip: string | null; userAgent: string | null; fbc: string | null; fbp: string | null; pagina: string | null;
  origen: string | null; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
}

export interface LeadVinculado { leadId: string; visitorId: string | null; origen: string }

export interface RepoTracking {
  registrarEvento(e: EventoRegistrable, destinos: Destino[]): Promise<{ duplicado: boolean }>;
  contarAnonimo(c: ConteoAnonimo): Promise<void>;
  registrarLead(l: { lead_id: string; visitor_id: string | null; event_id: string; vacante_ref: string | null; cliente_ref: string | null; origen: string }): Promise<void>;
  obtenerLead(leadId: string): Promise<LeadVinculado | null>;
  obtenerEvento(eventId: string): Promise<EventoGuardado | null>;
  /** Último contexto de navegador (IP, UA, fbc, fbp, UTM) del visitante. */
  contextoVisitante(visitorId: string): Promise<ContextoVisitanteGuardado | null>;
}

export interface MensajeCola { id: string; intentos: number; maxIntentos: number; payload: { destino: Destino; event_id: string; creado_en?: string } }
export interface ColaPort {
  tomar(n: number, vtSeg: number): Promise<MensajeCola[]>;
  completar(id: string): Promise<void>;
  fallar(id: string, error: string, backoffSeg: number): Promise<'reintento' | 'dead_letter'>;
}

export interface EventoOutbox { id: string; tipo: string; payload: Record<string, unknown> }
export interface OutboxPort {
  leer(tipos: readonly string[], n: number): Promise<EventoOutbox[]>;
  avanzar(ultimoId: string): Promise<void>;
}
export interface UnidadDeTrabajo { repo: RepoTracking; outbox: OutboxPort }

export interface ErrorEnvio { reintentable: boolean; status?: number; mensaje: string }
export interface MetaCapiPort { enviar(req: MetaCapiRequest): Promise<Result<{ eventosRecibidos: number }, ErrorEnvio>> }
export interface Ga4Port { enviar(req: EventoGa4Mp): Promise<Result<void, ErrorEnvio>> }

/** Contacto del lead para el match de CAPI. Implementación real: captacion.obtenerContactoLead. */
export interface Contacto { telefonoE164: string; email: string | null; nombrePila: string }
export interface ContactosPort { obtener(leadId: string): Promise<Contacto | null> }

export interface LimitadorPort { permitir(llave: string): boolean }

export type { Logger };

/** TRK-07 · Lugar de acceso: solo ciudad, región y país (nunca coordenadas, ISP ni la IP). */
export interface Geo { ciudad?: string | null; region?: string | null; pais?: string | null }

/**
 * TRK-07 · Geolocalización por IP. Orden de fuentes: (a) headers del CDN en la ingesta (síncrono, sin costo);
 * (b) este puerto, resuelto de forma ASÍNCRONA en el worker para los eventos sin dato del CDN; (c) null sin proveedor.
 * Recibe la red truncada (/24 IPv4, /48 IPv6), no la IP completa.
 */
export interface GeoIpPort {
  resolver(ipTruncada: string): Promise<Geo | null>;
}

export interface EventoSinGeo { eventId: string; creadoEn: string; ip: string }
export interface RepoGeoPort {
  /** Eventos con consentimiento, IP completa, sin ciudad/región/país y sin intento previo (últimos 7 días). */
  pendientes(n: number): Promise<EventoSinGeo[]>;
  /** Escribe el lugar (si lo hay) y marca el intento. Nunca pisa datos del CDN. */
  fijar(items: { eventId: string; creadoEn: string; geo: Geo | null }[]): Promise<number>;
}
