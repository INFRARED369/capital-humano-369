/**
 * PRV-02 · Solicitudes ARCO y revocación (Política §3). Solo las invoca un admin (edge function `arco`).
 * El teléfono del titular solo vive en memoria: se normaliza, se calcula su HMAC y se descarta.
 */
import { hmacSha256Hex, normalizarTelefonoMx } from '@shared/crypto.ts';
import { UUID_RE } from '@shared/ids.ts';
import { err, ok, type Result } from '@shared/result.ts';
import { requiereSupresion, transicionArco, vencimiento, type CanalArco, type EstadoArco, type TipoArco, type Vencimiento } from '../domain/arco.ts';
import { plazosArco } from '../domain/plazos.ts';
import type { DepsPrivacidad, ErrorSolicitud, ResultadoSupresion, SolicitudArco } from './puertos.ts';

export interface EntradaSolicitud {
  tipo: TipoArco;
  canal: CanalArco;
  telefono?: string;
  leadId?: string;
  /** Fecha real de recepción (ISO); por defecto, ahora. */
  recibidaEn?: string;
  creadoPor?: string | null;
  /** Ejecutar en el acto (revocación / cancelación "al instante", §3). */
  ejecutar?: boolean;
}

export type ErrorRegistro = 'SIN_IDENTIFICADOR' | 'TELEFONO_INVALIDO' | 'LEAD_INVALIDO' | 'FECHA_INVALIDA';

export interface SolicitudRegistrada {
  solicitudId: string;
  limiteRespuesta: string;
  limiteEjecucion: string;
  leads: number;
  ejecucion: ResultadoSupresion | null;
}

const hmacDe = (pepper: string, e164: string) => hmacSha256Hex(pepper, e164);

export async function registrarSolicitudArco(deps: DepsPrivacidad, e: EntradaSolicitud): Promise<Result<SolicitudRegistrada, ErrorRegistro | ErrorSolicitud>> {
  if (!e.telefono && !e.leadId) return err('SIN_IDENTIFICADOR');
  if (e.leadId && !UUID_RE.test(e.leadId)) return err('LEAD_INVALIDO');
  const ahora = deps.clock.now();
  const recibidaEn = e.recibidaEn ? new Date(e.recibidaEn) : ahora;
  if (Number.isNaN(recibidaEn.getTime()) || recibidaEn.getTime() > ahora.getTime()) return err('FECHA_INVALIDA');

  let telefono: string | null = null;
  if (e.telefono) {
    telefono = normalizarTelefonoMx(e.telefono);
    if (!telefono) return err('TELEFONO_INVALIDO');
  } else if (e.leadId) {
    telefono = await deps.contactos.telefonoDeLead(e.leadId); // null si el lead ya no existe
  }
  const telefonoHmac = telefono ? await hmacDe(deps.pepper, telefono) : null;
  const plazos = plazosArco(recibidaEn, { inhabiles: deps.inhabiles });
  const leads = e.leadId ? [e.leadId] : [];

  const solicitudId = await deps.repo.registrarSolicitud({
    tipo: e.tipo, canal: e.canal, telefonoHmac, leads, recibidaEn, ...plazos, creadoPor: e.creadoPor ?? null,
  });
  deps.logger.info('arco_registrada', { solicitud_id: solicitudId, tipo: e.tipo, canal: e.canal, con_hmac: telefonoHmac !== null });

  let ejecucion: ResultadoSupresion | null = null;
  if (e.ejecutar && requiereSupresion(e.tipo)) {
    const r = await ejecutarSolicitudArco(deps, solicitudId);
    if (!r.ok) return r;
    ejecucion = r.value;
  }
  const vista = await deps.repo.obtenerSolicitud(solicitudId);
  return ok({ solicitudId, ...plazos, leads: vista?.leads ?? leads.length, ejecucion });
}

export async function ejecutarSolicitudArco(deps: DepsPrivacidad, id: string): Promise<Result<ResultadoSupresion, ErrorSolicitud>> {
  const s = await deps.repo.obtenerSolicitud(id);
  if (!s) return err('NO_ENCONTRADA');
  const t = transicionArco(s.estado, 'ejecutar', s.tipo);
  if (!t.ok) return t;
  const r = await deps.repo.ejecutarSolicitud(id, deps.clock.now());
  if (r.ok) {
    deps.logger.info('arco_ejecutada', { solicitud_id: id, tipo: s.tipo, conteos: r.value.conteos });
    if (r.value.faltantes.length) deps.logger.warn('arco_incompleta', { solicitud_id: id, faltantes: r.value.faltantes });
  }
  return r;
}

export async function responderSolicitudArco(deps: DepsPrivacidad, id: string, estado: 'respondida' | 'rechazada', motivo: string): Promise<Result<void, ErrorSolicitud>> {
  const s = await deps.repo.obtenerSolicitud(id);
  if (!s) return err('NO_ENCONTRADA');
  const t = transicionArco(s.estado, estado === 'respondida' ? 'responder' : 'rechazar', s.tipo);
  if (!t.ok) return t;
  const r = await deps.repo.responderSolicitud(id, estado, motivo, deps.clock.now());
  if (r.ok) deps.logger.info('arco_cerrada', { solicitud_id: id, estado });
  return r;
}

export type SolicitudConPlazo = SolicitudArco & { vencimiento: Vencimiento };

const conPlazo = (deps: DepsPrivacidad, s: SolicitudArco): SolicitudConPlazo => ({ ...s, vencimiento: vencimiento(s, deps.clock.now()) });

export async function consultarSolicitudArco(deps: DepsPrivacidad, id: string): Promise<Result<SolicitudConPlazo, 'NO_ENCONTRADA'>> {
  const s = await deps.repo.obtenerSolicitud(id);
  return s ? ok(conPlazo(deps, s)) : err('NO_ENCONTRADA');
}

export async function listarSolicitudesArco(deps: DepsPrivacidad, f: { estado?: EstadoArco; limite?: number } = {}): Promise<SolicitudConPlazo[]> {
  return (await deps.repo.listarSolicitudes({ estado: f.estado, limite: f.limite ?? 100 })).map((s) => conPlazo(deps, s));
}
