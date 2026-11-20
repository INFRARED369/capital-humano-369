/**
 * Casos de uso de citas (F1 + ciclo de vida). Dependen solo de puertos; la transacción la
 * provee quien llama (el `tx` del contrato). Si un caso de uso devuelve error después de
 * escribir (reprogramar), quien llama debe revertir la transacción.
 */
import type { Clock } from '@shared/clock.ts';
import { UUID_RE } from '@shared/ids.ts';
import { err, ok, type Result } from '@shared/result.ts';
import { transicionar, type EstadoCita } from '../domain/estados.ts';
import { isoLocalConOffset } from '../domain/tiempo.ts';
import { generarSlots, validarInicio, type Slot } from '../domain/slots.ts';
import type { CitaRegistro, CitasRepo, ContactosPort, VacanteAgenda } from './puertos.ts';
import { reglasDeVacante } from './reglasVigentes.ts';

const DIA_MS = 86_400_000;
const MOTIVO_RE = /^[a-z0-9_]{1,40}$/;
const motivoSeguro = (m: string): string => (MOTIVO_RE.test(m) ? m : 'otro');
const esUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

// ---------------------------------------------------------------------------------------------
/** `agendaModo` (F7.4): en 'whatsapp' el sistema no ofrece slots y la landing lleva al candidato a WhatsApp. */
export interface SlotsVacante { vacanteId: string; agendaModo: VacanteAgenda['agendaModo']; slots: Slot[]; reglasVersion: number; zonaHoraria: string }

export async function obtenerSlotsCaso(repo: CitasRepo, clock: Clock, vacanteRef: string): Promise<Result<SlotsVacante, 'VACANTE_NO_ENCONTRADA'>> {
  const v = await repo.buscarVacante(vacanteRef);
  if (!v || !v.activa) return err('VACANTE_NO_ENCONTRADA');
  const { version, agenda } = await reglasDeVacante(repo, v.id);
  const base = { vacanteId: v.id, agendaModo: v.agendaModo, reglasVersion: version, zonaHoraria: agenda.zona_horaria };
  // F7.4: una vacante en modo WhatsApp no usa la agenda del sistema.
  if (v.agendaModo !== 'sistema') return ok({ ...base, slots: [] });

  const ahora = clock.now();
  await repo.expirarRetenciones(ahora.toISOString(), v.id);
  const ocupacion = await repo.ocupacion(
    v.id,
    new Date(ahora.getTime() - 2 * DIA_MS).toISOString(),
    new Date(ahora.getTime() + (agenda.horizonte_dias + 2) * DIA_MS).toISOString(),
    ahora.toISOString(),
  );
  return ok({ ...base, slots: generarSlots(agenda, ocupacion, clock) });
}

// ---------------------------------------------------------------------------------------------
export interface EntradaRetencion { vacanteId: string; leadId: string; inicio: string }
export type ErrorRetencion = 'SLOT_INVALIDO' | 'SLOT_LLENO' | 'CUPO_DIARIO' | 'VACANTE_NO_ENCONTRADA';

export async function retenerSlotCaso(
  repo: CitasRepo,
  entrada: EntradaRetencion,
  clock: Clock,
): Promise<Result<{ citaId: string; expiraEn: string; reglasVersion: number }, ErrorRetencion>> {
  if (!esUuid(entrada.vacanteId)) return err('VACANTE_NO_ENCONTRADA');
  if (!esUuid(entrada.leadId)) throw new Error('leadId inválido');
  const v = await repo.buscarVacante(entrada.vacanteId);
  if (!v || !v.activa) return err('VACANTE_NO_ENCONTRADA');
  if (v.agendaModo !== 'sistema') return err('SLOT_INVALIDO');
  const { version, agenda } = await reglasDeVacante(repo, v.id);
  const valido = validarInicio(agenda, entrada.inicio, clock);
  if (!valido.ok) return valido;

  const ahora = clock.now();
  const expiraEn = new Date(ahora.getTime() + agenda.ttl_retencion_min * 60_000).toISOString();
  const r = await repo.retener({
    vacanteId: v.id,
    leadId: entrada.leadId,
    inicio: valido.value.inicio,
    fin: valido.value.fin,
    dia: valido.value.fecha,
    capacidad: agenda.capacidad_por_slot,
    cupo: agenda.cupo_diario,
    empalmes: agenda.permitir_empalmes,
    reglasVersion: version,
    expiraEn,
    ahora: ahora.toISOString(),
    estado: 'retenida',
  });
  if (r.resultado === 'OK') return ok({ citaId: r.citaId, expiraEn, reglasVersion: version });
  // CITA_ACTIVA: el lead ya tiene una cita confirmada en la vacante (no amplía el contrato).
  return err(r.resultado === 'CITA_ACTIVA' ? 'SLOT_INVALIDO' : r.resultado);
}

// ---------------------------------------------------------------------------------------------
export interface EntradaConfirmacion { citaId: string; folio: string; nombrePila: string; eventId: string }
export type ErrorConfirmacion = 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA';

async function bloquearCita(repo: CitasRepo, citaId: string): Promise<CitaRegistro | null> {
  if (!esUuid(citaId)) return null;
  const c = await repo.obtener(citaId, { bloquear: true });
  return c && c.leadId ? c : null;
}

async function expirar(repo: CitasRepo, c: CitaRegistro, motivo: string, ahora: string): Promise<void> {
  await repo.cambiarEstado(c.id, { estado: 'expirada', ahora, motivo });
  await repo.publicar({ tipo: 'CitaExpirada', payload: { cita_id: c.id, lead_id: c.leadId!, vacante_id: c.vacanteId, cliente_id: c.clienteId } }, c.clienteId);
}

export async function confirmarCitaCaso(
  repo: CitasRepo,
  entrada: EntradaConfirmacion,
  clock: Clock,
): Promise<Result<{ citaId: string; inicio: string; fin: string }, ErrorConfirmacion>> {
  const c = await bloquearCita(repo, entrada.citaId);
  if (!c) return err('NO_ENCONTRADA');
  const valor = { citaId: c.id, inicio: c.inicio, fin: c.fin };
  if (c.estado === 'confirmada') return ok(valor); // idempotente: reintento de verificar-otp
  if (c.estado === 'expirada' && c.motivo === 'ttl') return err('EXPIRADA');
  const ahora = clock.now();
  if (c.estado === 'retenida' && c.expiraEn && Date.parse(c.expiraEn) <= ahora.getTime()) {
    await expirar(repo, c, 'ttl', ahora.toISOString());
    return err('EXPIRADA');
  }
  const t = transicionar(c.estado, 'confirmar');
  if (!t.ok) return t;
  await repo.cambiarEstado(c.id, { estado: t.value, ahora: ahora.toISOString() });
  await repo.publicar(
    {
      tipo: 'CitaConfirmada',
      payload: {
        cita_id: c.id,
        lead_id: c.leadId!,
        vacante_id: c.vacanteId,
        cliente_id: c.clienteId,
        inicio: c.inicio,
        fin: c.fin,
        folio: entrada.folio.trim().slice(0, 40),
        nombre_pila: entrada.nombrePila.trim().slice(0, 60),
        reglas_version: c.reglasVersion,
        event_id: entrada.eventId,
      },
    },
    c.clienteId,
  );
  return ok(valor);
}

// ---------------------------------------------------------------------------------------------
export async function liberarRetencionCaso(repo: CitasRepo, entrada: { citaId: string; motivo: string }, clock: Clock): Promise<void> {
  const c = await bloquearCita(repo, entrada.citaId);
  if (!c || c.estado !== 'retenida') return; // idempotente
  await expirar(repo, c, motivoSeguro(entrada.motivo), clock.now().toISOString());
}

// ---------------------------------------------------------------------------------------------
/**
 * Tope de la retención: RETENCION_MAX_TTLS × ttl_retencion_min desde que se retuvo (por defecto 3 × 10 = 30 min).
 * Coincide con el límite de 3 códigos OTP por teléfono por hora: cada reenvío puede renovar el TTL, pero un
 * candidato no puede acaparar el slot (que cuenta para la capacidad) más de 30 min sin verificar.
 */
export const RETENCION_MAX_TTLS = 3;
export type ErrorExtension = 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA';

export async function extenderRetencionCaso(
  repo: CitasRepo,
  entrada: { citaId: string },
  clock: Clock,
): Promise<Result<{ citaId: string; expiraEn: string }, ErrorExtension>> {
  const c = await bloquearCita(repo, entrada.citaId);
  if (!c) return err('NO_ENCONTRADA');
  if (c.estado !== 'retenida') return err(c.estado === 'expirada' ? 'EXPIRADA' : 'TRANSICION_INVALIDA');
  const ahora = clock.now();
  const actual = c.expiraEn ? Date.parse(c.expiraEn) : 0;
  if (actual <= ahora.getTime()) {
    await expirar(repo, c, 'ttl', ahora.toISOString());
    return err('EXPIRADA');
  }
  const { agenda } = await reglasDeVacante(repo, c.vacanteId);
  const ttl = agenda.ttl_retencion_min * 60_000;
  const base = c.creadoEn ? Date.parse(c.creadoEn) : actual - ttl;
  const nueva = Math.max(actual, Math.min(ahora.getTime() + ttl, base + RETENCION_MAX_TTLS * ttl));
  const expiraEn = new Date(nueva).toISOString();
  if (nueva !== actual) await repo.extenderRetencion(c.id, expiraEn, ahora.toISOString());
  return ok({ citaId: c.id, expiraEn });
}

// ---------------------------------------------------------------------------------------------
export type ErrorGestion = 'NO_ENCONTRADA' | 'TRANSICION_INVALIDA' | 'FUERA_DE_TIEMPO';

async function citaGestionable(repo: CitasRepo, citaId: string, accion: 'cancelar' | 'reprogramar', clock: Clock): Promise<Result<{ c: CitaRegistro; destino: EstadoCita }, ErrorGestion>> {
  const c = await bloquearCita(repo, citaId);
  if (!c) return err('NO_ENCONTRADA');
  const t = transicionar(c.estado, accion);
  if (!t.ok) return t;
  if (Date.parse(c.inicio) <= clock.now().getTime()) return err('FUERA_DE_TIEMPO');
  return ok({ c, destino: t.value });
}

export async function cancelarCitaCaso(
  repo: CitasRepo,
  entrada: { citaId: string; motivo: string },
  clock: Clock,
): Promise<Result<{ citaId: string }, ErrorGestion>> {
  const g = await citaGestionable(repo, entrada.citaId, 'cancelar', clock);
  if (!g.ok) return g;
  const { c, destino } = g.value;
  const motivo = motivoSeguro(entrada.motivo);
  await repo.cambiarEstado(c.id, { estado: destino, ahora: clock.now().toISOString(), motivo });
  await repo.publicar({ tipo: 'CitaCancelada', payload: { cita_id: c.id, lead_id: c.leadId!, vacante_id: c.vacanteId, cliente_id: c.clienteId, motivo } }, c.clienteId);
  return ok({ citaId: c.id });
}

// ---------------------------------------------------------------------------------------------
export type ErrorReprogramacion = ErrorGestion | 'SLOT_INVALIDO' | 'SLOT_LLENO' | 'CUPO_DIARIO';

/** Escribe y luego puede fallar: quien llama DEBE revertir la transacción si el resultado es error. */
export async function reprogramarCitaCaso(
  repo: CitasRepo,
  contactos: ContactosPort,
  entrada: { citaId: string; nuevoInicio: string },
  clock: Clock,
): Promise<Result<{ citaId: string; inicio: string; fin: string }, ErrorReprogramacion>> {
  const g = await citaGestionable(repo, entrada.citaId, 'reprogramar', clock);
  if (!g.ok) return g;
  const { c, destino } = g.value;
  const { version, agenda } = await reglasDeVacante(repo, c.vacanteId);
  const nuevo = validarInicio(agenda, entrada.nuevoInicio, clock);
  if (!nuevo.ok) return nuevo;
  if (nuevo.value.inicio === c.inicio) return err('SLOT_INVALIDO');
  const datos = await contactos.datosCita(c.leadId!);
  if (!datos) return err('NO_ENCONTRADA');

  const ahora = clock.now().toISOString();
  await repo.cambiarEstado(c.id, { estado: destino, ahora, motivo: 'candidato' });
  const r = await repo.retener({
    vacanteId: c.vacanteId,
    leadId: c.leadId!,
    inicio: nuevo.value.inicio,
    fin: nuevo.value.fin,
    dia: nuevo.value.fecha,
    capacidad: agenda.capacidad_por_slot,
    cupo: agenda.cupo_diario,
    empalmes: agenda.permitir_empalmes,
    reglasVersion: version,
    expiraEn: null,
    ahora,
    estado: 'confirmada',
    citaAnteriorId: c.id,
  });
  if (r.resultado !== 'OK') return err(r.resultado === 'SLOT_LLENO' || r.resultado === 'CUPO_DIARIO' ? r.resultado : 'SLOT_INVALIDO');
  await repo.publicar(
    {
      tipo: 'CitaReprogramada',
      payload: {
        cita_id: r.citaId,
        cita_anterior_id: c.id,
        lead_id: c.leadId!,
        vacante_id: c.vacanteId,
        cliente_id: c.clienteId,
        inicio: nuevo.value.inicio,
        fin: nuevo.value.fin,
        folio: datos.folio,
        nombre_pila: datos.nombrePila,
      },
    },
    c.clienteId,
  );
  return ok({ citaId: r.citaId, inicio: nuevo.value.inicio, fin: nuevo.value.fin });
}

// ---------------------------------------------------------------------------------------------
export interface CitaConsultada {
  citaId: string;
  vacanteId: string;
  estado: EstadoCita;
  inicio: string;
  fin: string;
  inicioLocal: string;
  zonaHoraria: string;
}

/** Para la página de gestión (sin PII: solo horario y estado). */
export async function consultarCitaCaso(repo: CitasRepo, citaId: string): Promise<Result<CitaConsultada, 'NO_ENCONTRADA'>> {
  if (!esUuid(citaId)) return err('NO_ENCONTRADA');
  const c = await repo.obtener(citaId, { bloquear: false });
  if (!c || !c.leadId) return err('NO_ENCONTRADA');
  const { agenda } = await reglasDeVacante(repo, c.vacanteId);
  return ok({
    citaId: c.id,
    vacanteId: c.vacanteId,
    estado: c.estado,
    inicio: c.inicio,
    fin: c.fin,
    inicioLocal: isoLocalConOffset(new Date(c.inicio), agenda.zona_horaria),
    zonaHoraria: agenda.zona_horaria,
  });
}
