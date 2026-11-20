/**
 * comunicacion-worker (F3): toma de shared.cola por prioridad → lease (M3) → contacto → opt-out (M4)
 * → ventana horaria (M6) → plantilla de la vacante (M8) → envío → costo por intento (COM-03)
 * → MensajeEnviado | reintento con backoff | dead letter + MensajeFallido (M1, M2).
 * El texto renderizado solo vive en memoria: nunca se guarda ni se loguea.
 */
import type { Clock } from '@shared/clock.ts';
import type { Logger } from '@shared/logger.ts';
import type { SqlClient } from '@shared/sql.ts';
import { descifrarCodigoOtp } from '../domain/otp.ts';
import { plantillaPara, renderPlantilla, type ReglasMensajes, type VariablesRender } from '../domain/plantillas.ts';
import { POLITICA_DEFECTO, type PoliticaReintento } from '../domain/reintento.ts';
import type { Canal } from '../domain/tipos.ts';
import { ajustarAVentana } from '../domain/ventana.ts';
import { hmacTelefono } from './privacidad.ts';
import type { Contacto, ContactosPort, EmailPort, ReglasVacantePort, ResultadoEnvio, SmsPort, WhatsAppPort } from './puertos.ts';
import * as repo from './repositorio.ts';

export interface DepsWorker {
  sql: SqlClient;
  clock: Clock;
  canales: { whatsapp?: WhatsAppPort; email?: EmailPort; sms?: SmsPort };
  contactos: ContactosPort;
  reglas: ReglasVacantePort;
  /** OTP_ENC_KEY (base64, 32 bytes). */
  otpKey: string;
  /** HMAC_PEPPER para el opt-out. */
  pepper: string;
  logger: Logger;
  politica?: PoliticaReintento;
  /** Costo por mensaje por canal (MXN) cuando el proveedor no lo informa. */
  tarifas?: Partial<Record<Canal, number>>;
  /** Visibility timeout / lease en segundos. */
  vtSeg?: number;
}

export interface ResumenLote {
  tomados: number;
  enviados: number;
  reintentos: number;
  dead_letter: number;
  omitidos: number;
  pospuestos: number;
  en_curso: number;
}

type Desenlace = Exclude<keyof ResumenLote, 'tomados'>;

export async function procesarLote(deps: DepsWorker, opts: { n?: number } = {}): Promise<ResumenLote> {
  const vt = deps.vtSeg ?? 60;
  const items = await repo.tomar(deps.sql, opts.n ?? 25, vt);
  const resumen: ResumenLote = { tomados: items.length, enviados: 0, reintentos: 0, dead_letter: 0, omitidos: 0, pospuestos: 0, en_curso: 0 };
  const cacheReglas = new Map<string, Promise<{ reglas: ReglasMensajes; origen: string }>>();
  const reglasDe = (vacanteId: string) => {
    let r = cacheReglas.get(vacanteId);
    if (!r) cacheReglas.set(vacanteId, (r = deps.reglas.obtener(vacanteId)));
    return r;
  };
  for (const item of items) resumen[await procesarItem(deps, item, vt, reglasDe)]++;
  if (resumen.tomados) deps.logger.info('lote procesado', { metrica: 'comunicacion.lote', ...resumen });
  return resumen;
}

async function procesarItem(
  deps: DepsWorker,
  item: repo.ItemCola,
  vt: number,
  reglasDe: (v: string) => Promise<{ reglas: ReglasMensajes; origen: string }>,
): Promise<Desenlace> {
  const politica = deps.politica ?? POLITICA_DEFECTO;
  const mensajeId = item.payload.mensaje_id;
  const ahora = deps.clock.now();
  if (!mensajeId) {
    await repo.completarCola(deps.sql, item.id);
    deps.logger.warn('item de cola sin mensaje_id', { cola_id: item.id });
    return 'omitidos';
  }
  const m = await repo.reclamar(deps.sql, mensajeId, ahora, vt);
  if (!m) {
    // M3: otro worker lo tiene (lease vigente) o ya terminó (enviado/cancelado/…): nunca se reenvía.
    const estado = await repo.estadoDe(deps.sql, mensajeId);
    if (estado === 'enviando') return 'en_curso';
    await repo.completarCola(deps.sql, item.id);
    return 'omitidos';
  }
  const log = deps.logger.child({ correlation_id: m.correlation_id ?? undefined, mensaje_id: m.id, tipo: m.tipo, canal: m.canal });

  const contacto = m.lead_id ? await deps.contactos.obtener(m.lead_id) : null;
  if (!contacto) {
    await repo.cerrarSinEnvio(deps.sql, item.id, m.id, 'omitido', 'SIN_CONTACTO');
    log.info('omitido: lead sin contacto (suprimido)');
    return 'omitidos';
  }
  if (await repo.enOptOut(deps.sql, await hmacTelefono(deps.pepper, contacto.telefonoE164))) {
    await repo.cerrarSinEnvio(deps.sql, item.id, m.id, 'omitido', 'OPT_OUT');
    log.info('omitido: opt-out');
    return 'omitidos';
  }

  const { reglas, origen } = await reglasDe(m.vacante_id);
  const cuando = ajustarAVentana(ahora, reglas.ventana_contacto, m.tipo);
  if (cuando.getTime() !== ahora.getTime()) {
    await repo.posponer(deps.sql, item.id, m, cuando, politica.maxIntentos - m.intentos);
    log.info('pospuesto por ventana horaria', { hasta: cuando.toISOString() });
    return 'pospuestos';
  }

  const intento = m.intentos + 1;
  const plantilla = plantillaPara(reglas, m.tipo);
  const etiquetaPlantilla = `${m.tipo}@${reglas.plantillas[m.tipo] ? origen : 'defecto'}`;
  // Avisos por correo a un lead sin email (es opcional en el formulario): salen por WhatsApp en vez de perderse.
  // El OTP no cambia de canal: lo eligió el candidato y la pantalla le muestra a dónde se envió.
  const canalEnvio: Canal = m.canal === 'email' && !contacto.email && m.tipo !== 'otp' && deps.canales.whatsapp ? 'whatsapp' : m.canal;
  if (canalEnvio !== m.canal) log.info('lead sin correo: se envía por whatsapp', { canal_envio: canalEnvio });
  const me = canalEnvio === m.canal ? m : { ...m, canal: canalEnvio };
  const canal = deps.canales[canalEnvio];
  const base = { m: me, colaId: item.id, intento, plantilla: etiquetaPlantilla };

  const contenido = await renderizar(deps, m, contacto, plantilla.texto, plantilla.asunto);
  if (!canal || !contenido.ok) {
    const motivo = !canal ? 'CANAL_NO_CONFIGURADO' : contenido.ok ? '' : contenido.error;
    await repo.registrarFallo(deps.sql, { ...base, proveedor: canal?.proveedor ?? 'ninguno', costoMxn: 0, proveedorId: null, motivo, definitiva: true, backoffSeg: 0, enviado: false });
    log.error('mensaje fallido sin envío', { motivo, metrica: 'comunicacion.dead_letter' });
    return 'dead_letter';
  }

  const resultado = await enviar(canalEnvio, canal, contacto, contenido.value);
  if (resultado.ok) {
    const costo = resultado.value.costoMxn ?? deps.tarifas?.[canalEnvio] ?? 0;
    await repo.registrarExito(deps.sql, { ...base, proveedor: canal.proveedor, costoMxn: costo, proveedorId: resultado.value.proveedorId });
    log.info('mensaje enviado', { intento, proveedor: canal.proveedor, costo_mxn: costo, metrica: 'comunicacion.enviado' });
    return 'enviados';
  }
  const decision = politica.decidir(intento, resultado.error);
  const destino = await repo.registrarFallo(deps.sql, {
    ...base,
    proveedor: canal.proveedor,
    costoMxn: resultado.error.costoMxn ?? 0,
    proveedorId: null,
    motivo: resultado.error.motivo,
    definitiva: decision.accion === 'dead_letter' && resultado.error.permanente,
    backoffSeg: decision.accion === 'reintentar' ? decision.backoffSeg : 0,
    enviado: true,
  });
  if (destino === 'dead_letter') {
    log.error('mensaje a dead letter', { intento, motivo: resultado.error.motivo, metrica: 'comunicacion.dead_letter' });
    return 'dead_letter';
  }
  log.warn('falla de envío; se reintentará', { intento, motivo: resultado.error.motivo });
  return 'reintentos';
}

type Contenido = { texto: string; asunto: string };

async function renderizar(deps: DepsWorker, m: repo.FilaMensaje, c: Contacto, texto: string, asunto: string | undefined) {
  const vars: VariablesRender = { ...(m.variables ?? {}), nombre: c.nombrePila, folio: c.folio };
  if (m.codigo_cifrado) {
    try {
      vars.codigo = await descifrarCodigoOtp(m.codigo_cifrado, deps.otpKey);
    } catch {
      return { ok: false as const, error: 'OTP_INDESCIFRABLE' };
    }
  }
  const t = renderPlantilla(texto, vars);
  if (!t.ok) return t;
  const a = renderPlantilla(asunto ?? 'Mensaje de 369 Capital Humano', vars);
  return a.ok ? { ok: true as const, value: { texto: t.value, asunto: a.value } satisfies Contenido } : a;
}

async function enviar(canal: Canal, port: WhatsAppPort | EmailPort | SmsPort, c: Contacto, contenido: Contenido): Promise<ResultadoEnvio> {
  try {
    if (canal === 'whatsapp') return await (port as WhatsAppPort).enviarTexto(c.telefonoE164, contenido.texto);
    if (canal === 'sms') return await (port as SmsPort).enviarSms(c.telefonoE164, contenido.texto);
    if (!c.email) return { ok: false, error: { motivo: 'SIN_EMAIL', permanente: true } };
    return await (port as EmailPort).enviar({ para: c.email, asunto: contenido.asunto, texto: contenido.texto });
  } catch {
    // El mensaje de la excepción puede traer PII (destino); solo se registra un código.
    return { ok: false, error: { motivo: 'EXCEPCION', permanente: false } };
  }
}
