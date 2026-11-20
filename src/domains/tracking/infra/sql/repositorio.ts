/** Adaptadores SQL de los puertos de tracking (PGlite en pruebas, `postgres` en Deno). */
import type { SqlClient } from '@shared/sql.ts';
import type { Destino } from '../../domain/eventos.ts';
import type { ColaPort, ContextoVisitanteGuardado, EventoGuardado, MensajeCola, OutboxPort, RepoTracking } from '../../application/puertos.ts';

export const COLA_CAPI = 'tracking-capi';

const fecha = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const hostIp = (v: unknown): string | null => (v == null ? null : String(v).replace(/\/\d+$/, ''));

export function crearRepoTrackingSql(sql: SqlClient): RepoTracking {
  return {
    async registrarEvento(e, destinos: Destino[]) {
      const { rows } = await sql.query<{ r: { duplicado: boolean } }>('select tracking.registrar_evento($1::jsonb, $2::text[]) as r', [JSON.stringify(e), destinos]);
      return { duplicado: rows[0]!.r.duplicado };
    },
    async contarAnonimo(c) {
      await sql.query('select tracking.contar_anonimo($1::jsonb)', [JSON.stringify(c)]);
    },
    async registrarLead(l) {
      await sql.query('select tracking.registrar_lead($1::jsonb)', [JSON.stringify(l)]);
    },
    async obtenerLead(leadId) {
      const { rows } = await sql.query<{ lead_id: string; visitor_id: string | null; origen: string }>(
        'select lead_id, visitor_id, origen from tracking.leads where lead_id = $1', [leadId]);
      const r = rows[0];
      return r ? { leadId: r.lead_id, visitorId: r.visitor_id, origen: r.origen } : null;
    },
    async obtenerEvento(eventId): Promise<EventoGuardado | null> {
      const { rows } = await sql.query<Record<string, unknown>>(
        `select e.event_id, e.nombre, e.fuente, e.creado_en, e.visitor_id, e.lead_id, coalesce(v.vacante_id, e.vacante_id) as vacante_id,
                coalesce(v.cliente_id, e.cliente_id) as cliente_id, e.content_category,
                e.pagina, host(e.ip) as ip, masklen(e.ip) = case family(e.ip) when 4 then 32 else 128 end as ip_completa,
                e.user_agent, e.fbc, e.fbp, e.propiedades
         from tracking.eventos_ids i join tracking.eventos e on e.event_id = i.event_id and e.creado_en = i.creado_en
         left join lateral shared.api_vacante_por_slug(e.vacante_id::text) v on true -- TRK-08: client_id real de la vacante
         where i.event_id = $1`, [eventId]);
      const r = rows[0];
      if (!r) return null;
      return {
        eventId: String(r.event_id), nombre: String(r.nombre), fuente: r.fuente as 'navegador' | 'servidor', creadoEn: fecha(r.creado_en),
        visitorId: (r.visitor_id as string) ?? null, leadId: (r.lead_id as string) ?? null, vacanteId: (r.vacante_id as string) ?? null,
        clienteId: String(r.cliente_id), contentCategory: (r.content_category as string) ?? null, pagina: (r.pagina as string) ?? null,
        ip: r.ip_completa ? hostIp(r.ip) : null, // IP truncada no sirve para el match: no se envía
        userAgent: (r.user_agent as string) ?? null, fbc: (r.fbc as string) ?? null, fbp: (r.fbp as string) ?? null,
        propiedades: (r.propiedades as Record<string, unknown>) ?? {},
      };
    },
    async contextoVisitante(visitorId): Promise<ContextoVisitanteGuardado | null> {
      interface Fila { ip: string | null; ip_completa: boolean | null; user_agent: string | null; fbc: string | null; fbp: string | null; pagina: string | null; origen: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null }
      const { rows } = await sql.query<Fila>(
        `select host(ip) as ip, masklen(ip) = case family(ip) when 4 then 32 else 128 end as ip_completa, user_agent, fbc, fbp, pagina, origen, utm_source, utm_medium, utm_campaign
         from tracking.eventos where visitor_id = $1 and fuente = 'navegador' order by creado_en desc limit 1`, [visitorId]);
      const r = rows[0];
      if (!r) return null;
      return {
        ip: r.ip_completa ? r.ip : null, userAgent: r.user_agent, fbc: r.fbc, fbp: r.fbp, pagina: r.pagina,
        origen: r.origen, utmSource: r.utm_source, utmMedium: r.utm_medium, utmCampaign: r.utm_campaign,
      };
    },
  };
}

export function crearColaSql(sql: SqlClient, cola = COLA_CAPI): ColaPort {
  return {
    async tomar(n, vt) {
      const { rows } = await sql.query<{ id: string | number; intentos: number; max_intentos: number; payload: MensajeCola['payload'] }>(
        'select id, intentos, max_intentos, payload from shared.tomar($1, $2, $3)', [cola, n, vt]);
      return rows.map((r) => ({ id: String(r.id), intentos: Number(r.intentos), maxIntentos: Number(r.max_intentos), payload: r.payload }));
    },
    async completar(id) {
      await sql.query('select shared.completar($1)', [id]);
    },
    async fallar(id, error, backoff) {
      const { rows } = await sql.query<{ r: 'reintento' | 'dead_letter' }>('select shared.fallar($1, $2, $3) as r', [id, error, backoff]);
      return rows[0]!.r;
    },
  };
}

export function crearOutboxSql(sql: SqlClient, consumidor: string): OutboxPort {
  return {
    async leer(tipos, n) {
      const { rows } = await sql.query<{ id: string | number; tipo: string; payload: Record<string, unknown> }>(
        'select id, tipo, payload from shared.leer_outbox($1, $2::text[], $3)', [consumidor, [...tipos], n]);
      return rows.map((r) => ({ id: String(r.id), tipo: r.tipo, payload: r.payload }));
    },
    async avanzar(id) {
      await sql.query('select shared.avanzar_outbox($1, $2)', [consumidor, id]);
    },
  };
}
