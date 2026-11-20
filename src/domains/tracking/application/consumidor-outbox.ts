/**
 * Consumidor del outbox (consumidor 'tracking'): registra en el recorrido los eventos de servidor y
 * encola sus conversiones. LeadCreado → Lead (mismo event_id que el Pixel), CitaConfirmada → Schedule
 * (solo tras OTP, T8), AsistenciaRegistrada → evento offline system_generated (TRK-09, T6),
 * LeadContratado → `Contratado` offline system_generated (TRK-09) UNA vez por cita: el event_id se deriva
 * de la cita, así el segundo LeadContratado (entrega del expediente, `entregado_en`) cae en la dedupe.
 * Política por defecto: sin consentimiento de cookies (visitor_id nulo) no se envía nada a terceros;
 * `capiSinCookies` habilita solo Meta (match por ph hasheado) si legal lo aprueba (Q-3).
 */
import { z } from 'zod';
import { sha256Hex } from '@shared/crypto.ts';
import { destinosDe, type EventoServidor } from '../domain/eventos.ts';
import { ORIGENES, type Origen } from '../domain/origen.ts';
import type { Logger, RepoTracking, UnidadDeTrabajo } from './puertos.ts';

export const CONSUMIDOR = 'tracking';
export const TIPOS_CONSUMIDOS = ['LeadCreado', 'WhatsAppVerificado', 'CitaConfirmada', 'AsistenciaRegistrada', 'LeadContratado'] as const satisfies readonly EventoServidor[];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const Base = z.object({ lead_id: uuid, vacante_id: uuid, cliente_id: uuid, event_id: uuid });
const Esquemas = {
  LeadCreado: Base.extend({ visitor_id: uuid.nullable(), origen: z.string().nullable() }),
  WhatsAppVerificado: Base,
  CitaConfirmada: Base,
  AsistenciaRegistrada: Base.extend({ asistio: z.boolean() }),
  LeadContratado: Base.extend({ cita_id: uuid.nullable(), entregado_en: z.string().nullable() }),
} satisfies Record<(typeof TIPOS_CONSUMIDOS)[number], z.ZodType>;

export interface DepsConsumidor {
  enTransaccion<T>(fn: (uow: UnidadDeTrabajo) => Promise<T>): Promise<T>;
  politica: { capiSinCookies: boolean };
  log: Logger;
}

/** UUID determinista (versión 8) derivado de tipo + event_id, para no chocar con el event_id del Lead. */
async function idDerivado(tipo: string, eventId: string): Promise<string> {
  const h = await sha256Hex(`${tipo}:${eventId}`);
  const v = `8${h.slice(13, 16)}`;
  const variante = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variante}-${h.slice(20, 32)}`;
}

const origenValido = (o: string | null | undefined): Origen => (ORIGENES as readonly string[]).includes(o ?? '') ? (o as Origen) : 'directo';

async function manejar(repo: RepoTracking, tipo: (typeof TIPOS_CONSUMIDOS)[number], payload: unknown, deps: DepsConsumidor): Promise<void> {
  const p = Esquemas[tipo].parse(payload) as z.infer<typeof Base> & { visitor_id?: string | null; origen?: string | null; asistio?: boolean; cita_id?: string | null };
  let visitor: string | null;
  let origen: Origen;
  let eventId = p.event_id;
  if (tipo === 'LeadCreado') {
    visitor = p.visitor_id ?? null;
    origen = origenValido(p.origen);
    await repo.registrarLead({ lead_id: p.lead_id, visitor_id: visitor, event_id: p.event_id, vacante_ref: p.vacante_id, cliente_ref: p.cliente_id, origen });
  } else {
    const lead = await repo.obtenerLead(p.lead_id);
    visitor = lead?.visitorId ?? null;
    origen = origenValido(lead?.origen);
    if (tipo === 'LeadContratado') {
      // Solo la primera contratación de la cita (o del lead) se convierte: la entrega se deduplica.
      eventId = await idDerivado(tipo, p.cita_id ?? p.lead_id);
    } else {
      const existente = await repo.obtenerEvento(p.event_id);
      if (existente && existente.nombre !== tipo) eventId = await idDerivado(tipo, p.event_id);
    }
  }
  const ctx = visitor ? await repo.contextoVisitante(visitor) : null;
  const props = tipo === 'AsistenciaRegistrada' ? { asistio: p.asistio === true } : {};
  const consentimiento = visitor !== null;
  let destinos = destinosDe(tipo, props, { consentimiento: consentimiento || deps.politica.capiSinCookies, origen: 'servidor' });
  if (!consentimiento) destinos = destinos.filter((d) => d === 'meta'); // GA4 necesita client_id = visitor_id
  await repo.registrarEvento(
    {
      event_id: eventId,
      nombre: tipo,
      fuente: 'servidor',
      consentimiento,
      origen,
      visitor_id: visitor,
      lead_id: p.lead_id,
      vacante_ref: p.vacante_id,
      cliente_ref: p.cliente_id,
      utm_source: ctx?.utmSource ?? null,
      utm_medium: ctx?.utmMedium ?? null,
      utm_campaign: ctx?.utmCampaign ?? null,
      propiedades: props,
    },
    destinos,
  );
}

export async function procesarOutbox(deps: DepsConsumidor, n = 100): Promise<{ procesados: number }> {
  return deps.enTransaccion(async ({ repo, outbox }) => {
    const eventos = await outbox.leer(TIPOS_CONSUMIDOS, n);
    for (const ev of eventos) {
      try {
        await manejar(repo, ev.tipo as (typeof TIPOS_CONSUMIDOS)[number], ev.payload, deps);
      } catch (e) {
        // Payload fuera de contrato: se registra y se salta para no bloquear el cursor.
        if (!(e instanceof z.ZodError)) throw e;
        deps.log.error('tracking-outbox: payload inválido', { outbox_id: ev.id, tipo: ev.tipo });
      }
    }
    if (eventos.length) await outbox.avanzar(eventos[eventos.length - 1]!.id);
    return { procesados: eventos.length };
  });
}
