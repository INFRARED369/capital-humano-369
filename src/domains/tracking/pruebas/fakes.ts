/** Fakes en memoria de los puertos (solo pruebas). */
import { ok, err } from '@shared/result.ts';
import type { ColaPort, ContactosPort, ContextoVisitanteGuardado, EventoGuardado, EventoRegistrable, Ga4Port, LeadVinculado, MensajeCola, MetaCapiPort, OutboxPort, RepoTracking } from '../application/puertos.ts';
import type { Destino } from '../domain/eventos.ts';

export function repoFalso() {
  const eventos = new Map<string, EventoRegistrable & { destinos: Destino[]; creadoEn: Date }>();
  const anonimos: unknown[] = [];
  const leads = new Map<string, LeadVinculado & { event_id: string }>();
  const contextos = new Map<string, ContextoVisitanteGuardado>();
  const repo: RepoTracking = {
    async registrarEvento(e, destinos) {
      if (eventos.has(e.event_id)) return { duplicado: true };
      eventos.set(e.event_id, { ...e, destinos, creadoEn: new Date('2026-11-13T18:00:00Z') });
      return { duplicado: false };
    },
    async contarAnonimo(c) { anonimos.push(c); },
    async registrarLead(l) { if (!leads.has(l.lead_id)) leads.set(l.lead_id, { leadId: l.lead_id, visitorId: l.visitor_id ?? null, origen: l.origen, event_id: l.event_id }); },
    async obtenerLead(id) { return leads.get(id) ?? null; },
    async obtenerEvento(id): Promise<EventoGuardado | null> {
      const e = eventos.get(id);
      if (!e) return null;
      return {
        eventId: e.event_id, nombre: e.nombre, fuente: e.fuente, creadoEn: e.creadoEn, visitorId: e.visitor_id ?? null, leadId: e.lead_id ?? null,
        vacanteId: e.vacante_ref ?? null, clienteId: e.cliente_ref ?? '00000000-0000-0000-0000-000000000000', contentCategory: e.content_category ?? null,
        pagina: e.pagina ?? null, ip: e.ip ?? null, userAgent: e.user_agent ?? null, fbc: e.fbc ?? null, fbp: e.fbp ?? null, propiedades: e.propiedades ?? {},
      };
    },
    async contextoVisitante(v) { return contextos.get(v) ?? null; },
  };
  return { repo, eventos, anonimos, leads, contextos };
}

export function colaFalsa(mensajes: MensajeCola[]) {
  const estado = new Map<string, string>();
  const backoffs: number[] = [];
  const cola: ColaPort = {
    async tomar(n) {
      const disp = mensajes.filter((m) => !estado.has(m.id) || estado.get(m.id) === 'reintento').slice(0, n);
      disp.forEach((m) => { m.intentos += 1; estado.set(m.id, 'en_proceso'); });
      return disp.map((m) => ({ ...m, payload: { ...m.payload } }));
    },
    async completar(id) { estado.set(id, 'completado'); },
    async fallar(id, _e, backoff) {
      backoffs.push(backoff);
      const m = mensajes.find((x) => x.id === id)!;
      const r = m.intentos >= m.maxIntentos ? 'dead_letter' : 'reintento';
      estado.set(id, r);
      return r;
    },
  };
  return { cola, estado, backoffs };
}

export function metaFalsa(respuestas: Array<'ok' | 500 | 400 | 'red'> = ['ok']) {
  const enviados: unknown[] = [];
  let i = 0;
  const meta: MetaCapiPort = {
    async enviar(req) {
      enviados.push(req);
      const r = respuestas[Math.min(i++, respuestas.length - 1)];
      if (r === 'ok') return ok({ eventosRecibidos: 1 });
      if (r === 'red') return err({ reintentable: true, mensaje: 'red' });
      return err({ reintentable: r === 500, status: r, mensaje: `HTTP ${r}` });
    },
  };
  return { meta, enviados };
}

export function ga4Falso() {
  const enviados: unknown[] = [];
  const ga4: Ga4Port = { async enviar(req) { enviados.push(req); return ok(undefined); } };
  return { ga4, enviados };
}

export function contactosFalsos(map: Record<string, { telefonoE164: string; email: string | null; nombrePila: string }>): ContactosPort {
  return { obtener: async (id) => map[id] ?? null };
}

export function outboxFalso(eventos: Array<{ id: string; tipo: string; payload: Record<string, unknown> }>) {
  let cursor = 0;
  const outbox: OutboxPort = {
    async leer(tipos, n) { return eventos.filter((e) => Number(e.id) > cursor && tipos.includes(e.tipo)).slice(0, n); },
    async avanzar(id) { cursor = Math.max(cursor, Number(id)); },
  };
  return { outbox, get cursor() { return cursor; } };
}

export const logNulo = { debug() {}, info() {}, warn() {}, error() {}, child() { return logNulo; } };
