/**
 * Dobles de prueba de los puertos de Captación (solo pruebas). Escriben en la MISMA transacción
 * que reciben para poder probar la atomicidad (P3): si la transacción se revierte, desaparecen.
 */
import { crearLogger } from '../../../../shared/logger.ts';
import { FixedClock } from '../../../../shared/clock.ts';
import { err, ok, type Result } from '../../../../shared/result.ts';
import type { SqlClient } from '../../../../shared/sql.ts';
import type { AgendaPort, AntiBotPort, DepsCaptacion, MensajeriaPort, SolicitudMensaje, VerificadorWhatsAppPort } from '../../application/puertos.ts';
import type { Pregunta } from '../../domain/formulario.ts';
import { crearRepoSql } from '../sql/repo.ts';

export const PREGUNTAS_PRUEBA: Pregunta[] = [
  { id: 'edad', etiqueta: 'Edad', tipo: 'numero', requerida: true, min: 14, max: 99 },
  { id: 'manejo_pc', etiqueta: '¿PC?', tipo: 'opcion', requerida: true, presentacion: 'tarjetas', opciones: [{ valor: 'si', etiqueta: 'Sí' }, { valor: 'no', etiqueta: 'No' }] },
  { id: 'papeleria', etiqueta: '¿Papelería?', tipo: 'opcion', requerida: true, presentacion: 'tarjetas', opciones: [{ valor: 'si', etiqueta: 'Sí' }, { valor: 'no', etiqueta: 'No' }] },
];

type ErrorRetener = 'SLOT_INVALIDO' | 'SLOT_LLENO' | 'CUPO_DIARIO' | 'VACANTE_NO_ENCONTRADA';
type ErrorConfirmar = 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA';

export class AgendaFalsa implements AgendaPort {
  retenciones: Array<{ vacanteId: string; leadId: string; inicio: string; citaId: string }> = [];
  confirmaciones: Array<{ citaId: string; folio: string; nombrePila: string; eventId: string }> = [];
  liberadas: Array<{ citaId: string; motivo: string }> = [];
  extendidas: string[] = [];
  errorExtender: 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA' | null = null;
  errorRetener: ErrorRetener | null = null;
  errorConfirmar: ErrorConfirmar | null = null;
  constructor(private clienteId = '00000000-0000-0000-0000-000000000001') {}

  async retener(tx: SqlClient, i: { vacanteId: string; leadId: string; inicio: string }): Promise<Result<{ citaId: string; expiraEn: string; reglasVersion: number }, ErrorRetener>> {
    if (this.errorRetener) return err(this.errorRetener);
    const citaId = globalThis.crypto.randomUUID();
    // Simula a citas escribiendo en la misma transacción.
    await tx.query(`select shared.publicar_evento('CitaRetenida', $1::jsonb, $2)`, [JSON.stringify({ cita_id: citaId, lead_id: i.leadId }), this.clienteId]);
    this.retenciones.push({ ...i, citaId });
    return ok({ citaId, expiraEn: new Date(Date.parse(i.inicio)).toISOString(), reglasVersion: 1 });
  }
  async confirmar(_tx: SqlClient, i: { citaId: string; folio: string; nombrePila: string; eventId: string }): Promise<Result<{ citaId: string; inicio: string; fin: string }, ErrorConfirmar>> {
    if (this.errorConfirmar) return err(this.errorConfirmar);
    const r = this.retenciones.find((x) => x.citaId === i.citaId);
    if (!r) return err('NO_ENCONTRADA');
    this.confirmaciones.push(i);
    return ok({ citaId: i.citaId, inicio: r.inicio, fin: new Date(Date.parse(r.inicio) + 90 * 60_000).toISOString() });
  }
  async liberar(_tx: SqlClient, i: { citaId: string; motivo: string }): Promise<void> {
    this.liberadas.push(i);
  }
  async extender(_tx: SqlClient, i: { citaId: string }): Promise<Result<{ citaId: string; expiraEn: string }, 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA'>> {
    if (this.errorExtender) return err(this.errorExtender);
    this.extendidas.push(i.citaId);
    return ok({ citaId: i.citaId, expiraEn: this.expiraExtendida ?? new Date(0).toISOString() });
  }
  /** Lo que devuelve `extender` (por defecto la expiración del OTP nuevo la fija la prueba). */
  expiraExtendida: string | null = null;
}

export class MensajeriaFalsa implements MensajeriaPort {
  enviados: SolicitudMensaje[] = [];
  fallar = false;
  async encolar(tx: SqlClient, s: SolicitudMensaje): Promise<{ mensajeId: string }> {
    if (this.fallar) throw new Error('cola caída');
    const { rows } = await tx.query<{ id: string }>(`select shared.encolar('comunicacion', $1::jsonb, $2, 0::smallint, $3) as id`, [JSON.stringify(s), s.llave, s.clienteId]);
    this.enviados.push(s);
    return { mensajeId: String(rows[0]!.id) };
  }
}

export class WhatsAppFalso implements VerificadorWhatsAppPort {
  inexistentes = new Set<string>();
  caido = false;
  consultas: string[] = [];
  async existeEnWhatsApp(t: string): Promise<boolean> {
    this.consultas.push(t);
    if (this.caido) throw new Error('evolution caído');
    return !this.inexistentes.has(t);
  }
}

export class AntiBotFalso implements AntiBotPort {
  async verificar(token: string): Promise<boolean> {
    if (token === 'caido') throw new Error('turnstile caído');
    return token === 'ok';
  }
}

/** AES-GCM real con una clave de prueba; registra los códigos en claro para que la prueba pueda "leer el WhatsApp". */
export function cifradorPrueba() {
  const codigos: string[] = [];
  const clave = globalThis.crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt']);
  return {
    codigos,
    cifrar: async (codigo: string) => {
      codigos.push(codigo);
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await clave, new TextEncoder().encode(codigo)));
      return Buffer.from([...iv, ...ct]).toString('base64');
    },
  };
}

export function crearDepsPrueba(sql: SqlClient, o: { ahora?: string; preguntas?: Record<string, Pregunta[]> } = {}) {
  const agenda = new AgendaFalsa();
  const mensajeria = new MensajeriaFalsa();
  const whatsapp = new WhatsAppFalso();
  const cifrador = cifradorPrueba();
  const clock = new FixedClock(new Date(o.ahora ?? '2026-11-16T15:00:00Z'));
  const logs: string[] = [];
  const preguntas = o.preguntas ?? { 'agente-smart': PREGUNTAS_PRUEBA };
  const deps: DepsCaptacion = {
    sql,
    repo: (c) => crearRepoSql(c),
    agenda,
    mensajeria,
    whatsapp,
    antiBot: new AntiBotFalso(),
    formularios: { preguntas: (slug) => preguntas[slug] ?? null },
    cifrarCodigo: cifrador.cifrar,
    hmacPepper: 'pepper-de-prueba',
    clock,
    logger: crearLogger({ fn: 'prueba' }, (l) => logs.push(l)),
  };
  return { deps, agenda, mensajeria, whatsapp, cifrador, clock, logs };
}
