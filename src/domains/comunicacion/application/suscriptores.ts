/**
 * Suscriptor del outbox (consumidor `comunicacion`), COM-06 / M7:
 *  CitaConfirmada       → confirmación + recordatorios (24 h y 2 h, configurables)
 *  CitaCancelada        → cancela pendientes de la cita + aviso de cancelación
 *  CitaReprogramada     → cancela pendientes de la cita anterior + aviso + recordatorios de la nueva
 *  AsistenciaRegistrada → (asistio) agradecimiento
 * Todo en UNA transacción con el avance del cursor; las llaves `<tipo>:<cita>` lo hacen idempotente.
 */
import { z } from 'zod';
import type { Clock } from '@shared/clock.ts';
import type { Logger } from '@shared/logger.ts';
import type { SqlClient } from '@shared/sql.ts';
import { programarRecordatorios } from '../domain/recordatorios.ts';
import type { TipoMensaje } from '../domain/tipos.ts';
import { formatearFechaHora } from '../domain/ventana.ts';
import type { ReglasMensajes } from '../domain/plantillas.ts';
import { encolarMensaje } from './encolar.ts';
import type { LinksGestionPort, ReglasVacantePort } from './puertos.ts';
import { cancelarPendientesDeCita } from './repositorio.ts';

export const CONSUMIDOR = 'comunicacion';
export const TIPOS_SUSCRITOS = ['CitaConfirmada', 'CitaCancelada', 'CitaReprogramada', 'AsistenciaRegistrada'] as const;
const PENDIENTES_DE_CITA: TipoMensaje[] = ['confirmacion', 'recordatorio_24h', 'recordatorio_2h'];

export interface DepsSuscriptores {
  sql: SqlClient;
  clock: Clock;
  /** Se construye sobre la transacción del outbox (lecturas consistentes, sin segunda conexión). */
  reglasEn: (tx: SqlClient) => ReglasVacantePort;
  links: LinksGestionPort;
  logger: Logger;
}

export interface ResumenSuscriptores {
  eventos: number;
  encolados: number;
  cancelados: number;
  invalidos: number;
}

const id = z.uuid();
const base = { cita_id: id, lead_id: id, vacante_id: id, cliente_id: id };
const iso = z.iso.datetime({ offset: true });
const Esquemas = {
  CitaConfirmada: z.object({ ...base, inicio: iso }),
  CitaCancelada: z.object({ ...base, motivo: z.string().optional() }),
  CitaReprogramada: z.object({ ...base, cita_anterior_id: id, inicio: iso }),
  AsistenciaRegistrada: z.object({ ...base, asistio: z.boolean() }),
} as const;

type Fila = { id: string; tipo: (typeof TIPOS_SUSCRITOS)[number]; payload: unknown; correlation_id: string | null };

export async function procesarEventosCitas(deps: DepsSuscriptores, n = 100): Promise<ResumenSuscriptores> {
  return deps.sql.transaction(async (tx) => {
    const resumen: ResumenSuscriptores = { eventos: 0, encolados: 0, cancelados: 0, invalidos: 0 };
    const { rows } = await tx.query<Fila>(`select id::text as id, tipo, payload, correlation_id from shared.leer_outbox($1, $2::text[], $3)`, [CONSUMIDOR, TIPOS_SUSCRITOS, n]);
    for (const ev of rows) {
      resumen.eventos++;
      const p = Esquemas[ev.tipo].safeParse(ev.payload);
      if (!p.success) {
        resumen.invalidos++;
        deps.logger.error('evento inválido en outbox; se salta', { evento_id: ev.id, tipo: ev.tipo, correlation_id: ev.correlation_id });
        continue;
      }
      await manejar(deps, tx, ev.tipo, p.data as never, ev.correlation_id, resumen);
    }
    if (rows.length) await tx.query(`select shared.avanzar_outbox($1, $2)`, [CONSUMIDOR, rows[rows.length - 1]!.id]);
    if (resumen.eventos) deps.logger.info('eventos de citas procesados', { metrica: 'comunicacion.outbox', ...resumen });
    return resumen;
  });
}

type P = { cita_id: string; lead_id: string; vacante_id: string; cliente_id: string; inicio?: string; cita_anterior_id?: string; asistio?: boolean; motivo?: string };

async function manejar(deps: DepsSuscriptores, tx: SqlClient, tipo: Fila['tipo'], p: P, correlationId: string | null, r: ResumenSuscriptores): Promise<void> {
  const { reglas } = await deps.reglasEn(tx).obtener(p.vacante_id);
  const encolar = async (t: TipoMensaje, citaId: string, extra: { variables?: Record<string, string>; programadoPara?: string } = {}) => {
    await encolarMensaje(tx, {
      tipo: t,
      canal: reglas.canal_preferido,
      leadId: p.lead_id,
      vacanteId: p.vacante_id,
      clienteId: p.cliente_id,
      citaId,
      llave: `${t}:${citaId}`,
      correlationId: correlationId ?? undefined,
      ...extra,
    });
    r.encolados++;
  };

  switch (tipo) {
    case 'CitaConfirmada':
      await avisoYRecordatorios(deps, reglas, p.cita_id, p.inicio!, 'confirmacion', encolar);
      return;
    case 'CitaCancelada':
      r.cancelados += await cancelarPendientesDeCita(tx, p.cita_id, PENDIENTES_DE_CITA, 'CITA_CANCELADA');
      // Supresión ARCO/retención: se cancelan los pendientes pero no se avisa a un lead suprimido.
      if (p.motivo === 'supresion') return;
      await encolar('cancelacion', p.cita_id);
      return;
    case 'CitaReprogramada':
      r.cancelados += await cancelarPendientesDeCita(tx, p.cita_anterior_id!, PENDIENTES_DE_CITA, 'CITA_REPROGRAMADA');
      await avisoYRecordatorios(deps, reglas, p.cita_id, p.inicio!, 'reprogramacion', encolar);
      return;
    case 'AsistenciaRegistrada':
      if (!p.asistio) return;
      r.cancelados += await cancelarPendientesDeCita(tx, p.cita_id, PENDIENTES_DE_CITA, 'CITA_ATENDIDA');
      await encolar('agradecimiento', p.cita_id);
      return;
  }
}

async function avisoYRecordatorios(
  deps: DepsSuscriptores,
  reglas: ReglasMensajes,
  citaId: string,
  inicioIso: string,
  aviso: 'confirmacion' | 'reprogramacion',
  encolar: (t: TipoMensaje, citaId: string, extra?: { variables?: Record<string, string>; programadoPara?: string }) => Promise<void>,
): Promise<void> {
  const inicio = new Date(inicioIso);
  const expiraEn = inicio.toISOString();
  const [linkCancelar, linkReprogramar] = await Promise.all([
    deps.links.firmar({ citaId, accion: 'cancelar', expiraEn }),
    deps.links.firmar({ citaId, accion: 'reprogramar', expiraEn }),
  ]);
  const variables = { ...formatearFechaHora(inicio, reglas.ventana_contacto.zona_horaria), link_cancelar: linkCancelar, link_reprogramar: linkReprogramar };
  await encolar(aviso, citaId, { variables });
  for (const rec of programarRecordatorios(inicio, deps.clock.now(), reglas)) await encolar(rec.tipo, citaId, { variables, programadoPara: rec.programadoPara });
}
