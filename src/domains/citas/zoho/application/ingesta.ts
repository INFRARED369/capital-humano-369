/**
 * Ingesta del outbox → estado deseado en citas.zoho_eventos → cola `zoho-sync` (CIT-08).
 * Todo en una transacción con el avance del cursor: o se aplica el lote completo o nada.
 * Idempotente (Z2): la llave de la cola es el evento_id del outbox y la inserción ignora duplicados.
 */
import { z } from 'zod';
import { normalizarCalendarUid, uidPropioDe } from '../domain/evento.ts';
import type { AlertaZoho, IngestaTx, NuevoRegistro, RegistroZoho } from './puertos.ts';
import type { Logger } from '@shared/logger.ts';

export const TIPOS_CONSUMIDOS = ['CitaConfirmada', 'CitaReprogramada', 'CitaCancelada'] as const;

const id = z.string().uuid();
const iso = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'fecha');
const Base = z.object({ cita_id: id, lead_id: id, vacante_id: id, cliente_id: id });
const ConfirmadaSchema = Base.extend({ inicio: iso, fin: iso, folio: z.string().min(1).max(40), nombre_pila: z.string().max(200) });
const ReprogramadaSchema = ConfirmadaSchema.extend({ cita_anterior_id: id });
const CanceladaSchema = Base;

export interface ResumenIngesta {
  ingeridos: number;
  descartados: number;
}

const TERMINALES = new Set(['borrado', 'reemplazado']);
const activo = (r: RegistroZoho | null): r is RegistroZoho => !!r && !TERMINALES.has(r.estadoSync);

function alertaConfig(p: z.infer<typeof Base>): AlertaZoho {
  return { tipo: 'ZOHO_CONFIG_INCOMPLETA', clienteId: p.cliente_id, vacanteId: p.vacante_id, citaId: p.cita_id, detalle: { falta: 'zoho_calendar_uid' } };
}

async function nuevoRegistro(tx: IngestaTx, p: z.infer<typeof ConfirmadaSchema>, zohoEventUid: string | null = null): Promise<NuevoRegistro> {
  const cal = normalizarCalendarUid(await tx.calendarioDe(p.vacante_id));
  return {
    citaId: p.cita_id, clienteId: p.cliente_id, vacanteId: p.vacante_id, leadId: p.lead_id,
    zohoCalendarUid: cal, zohoEventUid: cal ? zohoEventUid : null, uidPropio: uidPropioDe(p.cita_id),
    estadoSync: cal ? 'pendiente' : 'sin_calendario', inicio: p.inicio, fin: p.fin, folio: p.folio, nombrePila: p.nombre_pila,
  };
}

async function publicarNuevo(tx: IngestaTx, r: NuevoRegistro, p: z.infer<typeof ConfirmadaSchema>, llave: string): Promise<void> {
  if (!(await tx.insertar(r))) return; // entrega duplicada
  if (r.zohoCalendarUid) await tx.encolar(r.citaId, r.clienteId, llave);
  else await tx.alertar(alertaConfig(p)); // Z7: la cita sigue confirmada, solo se avisa
}

/** Deja de publicar una cita: si tiene calendario, el worker borrará el evento. */
async function retirar(tx: IngestaTx, r: RegistroZoho, llave: string): Promise<void> {
  if (r.zohoCalendarUid) {
    await tx.marcar(r.citaId, { vigente: false, estadoSync: 'pendiente' });
    await tx.encolar(r.citaId, r.clienteId, llave);
  } else {
    await tx.marcar(r.citaId, { vigente: false, estadoSync: 'borrado' });
  }
}

async function aplicar(tx: IngestaTx, tipo: string, payload: unknown, llave: string): Promise<boolean> {
  switch (tipo) {
    case 'CitaConfirmada': {
      const p = ConfirmadaSchema.safeParse(payload);
      if (!p.success) return false;
      await publicarNuevo(tx, await nuevoRegistro(tx, p.data), p.data, llave);
      return true;
    }
    case 'CitaReprogramada': {
      const p = ReprogramadaSchema.safeParse(payload);
      if (!p.success) return false;
      const ant = await tx.obtener(p.data.cita_anterior_id);
      const borrador = await nuevoRegistro(tx, p.data);
      // Z4: el evento existente pasa a la nueva cita (se actualiza, no se duplica) si sigue en el mismo calendario.
      const transferible = activo(ant) && !!ant.zohoEventUid && ant.zohoCalendarUid === borrador.zohoCalendarUid;
      if (transferible) await tx.marcar(ant.citaId, { vigente: false, estadoSync: 'reemplazado', quitarEventUid: true });
      else if (activo(ant)) await retirar(tx, ant, `${llave}:anterior`);
      await publicarNuevo(tx, { ...borrador, zohoEventUid: transferible ? ant.zohoEventUid : null }, p.data, llave);
      return true;
    }
    case 'CitaCancelada': {
      const p = CanceladaSchema.safeParse(payload);
      if (!p.success) return false;
      const r = await tx.obtener(p.data.cita_id);
      if (activo(r) && r.vigente) await retirar(tx, r, llave);
      return true;
    }
    default:
      return false;
  }
}

export async function ingerirOutbox(deps: { ingesta: { enTransaccion<T>(fn: (tx: IngestaTx) => Promise<T>): Promise<T> }; logger: Logger }, lote: number): Promise<ResumenIngesta> {
  return deps.ingesta.enTransaccion(async (tx) => {
    const eventos = await tx.leer(lote);
    let descartados = 0;
    for (const e of eventos) {
      if (!(await aplicar(tx, e.tipo, e.payload, e.eventoId))) {
        descartados++;
        deps.logger.warn('zoho: evento del outbox descartado (payload inválido)', { outbox_id: e.id, tipo: e.tipo });
      }
    }
    if (eventos.length > 0) await tx.avanzar(eventos[eventos.length - 1]!.id);
    return { ingeridos: eventos.length, descartados };
  });
}
