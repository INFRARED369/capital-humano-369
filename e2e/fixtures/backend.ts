/**
 * Backend SIMULADO con estado para los E2E (E2E-01..13). Implementa en memoria los CONTRATOS HTTP de las edge
 * functions (citas-api, postular, verificar-otp, gestionar-cita, panel-reglas, tracking-ingest), Supabase Auth y
 * PostgREST (con RLS simulado por rol) y los "workers" asíncronos (outbox → Comunicación/Evolution, Zoho Calendar
 * y Meta CAPI), que llaman por HTTP al servidor de mocks de proveedores (`proveedores.ts`).
 *
 * Fidelidad: usa las funciones PURAS reales de los dominios (no copias): `generarSlots`/`puedeReservar` (citas),
 * `validarPostulacion` + `evaluarIntento` + `evaluarLimiteEnvio` + `generarFolio` (captación), `firmarLinkGestion`/
 * `verificarLinkGestion` (links de gestión), `ReglasVacanteSchema` (panel), `construirEventoMinimo` (Zoho) y
 * `construirEventoMeta` (CAPI). Lo que se simula es la persistencia (un objeto JS = una transacción serializada,
 * así que "dos peticiones al último lugar" dan exactamente 1 éxito, como el lock por (vacante, día)).
 *
 * Reloj: el backend tiene su propio reloj (fijo al inicio: martes 17-nov-2026 09:00 CDMX). E2E-05 lo avanza junto
 * con `page.clock` para simular que pasan 10 minutos.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Request, Route } from '@playwright/test';
import { ReglasVacanteSchema, type ReglasVacante } from '../../src/domains/vacantes/domain/reglas.ts';
import { generarSlots, puedeReservar, type Slot } from '../../src/domains/citas/domain/slots.ts';
import { firmarLinkGestion, verificarLinkGestion } from '../../src/domains/citas/domain/links.ts';
import { construirEventoMinimo } from '../../src/domains/citas/zoho/domain/evento.ts';
import { validarPostulacion, type Pregunta } from '../../src/domains/captacion/domain/formulario.ts';
import { evaluarIntento, evaluarLimiteEnvio, OTP } from '../../src/domains/captacion/domain/otp.ts';
import { generarFolio } from '../../src/domains/captacion/domain/lead.ts';
import { construirEventoMeta } from '../../src/domains/tracking/domain/capi.ts';
import { uuidv7 } from '../../src/shared/ids.ts';
import type { MocksProveedores } from './proveedores';

// ---------------------------------------------------------------------------------------------
// Identificadores fijos del escenario (dos clientes, dos vacantes, cuatro usuarios)
// ---------------------------------------------------------------------------------------------
export const IDS = {
  clienteA: 'ca000000-0000-4000-8000-000000000001',
  clienteB: 'cb000000-0000-4000-8000-000000000002',
  vacanteA: 'a0000000-0000-4000-8000-000000000001', // agente-smart (landing real)
  vacanteB: 'b0000000-0000-4000-8000-000000000002', // otra vacante de otro cliente
} as const;

export interface UsuarioSim { id: string; email: string; password: string; rol: 'admin' | 'reclutador' | 'cliente'; vacantes: string[] }
export const PASSWORD_E2E = 'Una-Contrasena-Larga-1';
export const USUARIOS: Record<'admin' | 'reclutadorA' | 'reclutadorB' | 'clienteA', UsuarioSim> = {
  admin: { id: 'd0000000-0000-4000-8000-0000000000ad', email: 'admin@e2e.test', password: PASSWORD_E2E, rol: 'admin', vacantes: [] },
  reclutadorA: { id: 'd0000000-0000-4000-8000-00000000000a', email: 'reclutador@e2e.test', password: PASSWORD_E2E, rol: 'reclutador', vacantes: [IDS.vacanteA] },
  reclutadorB: { id: 'd0000000-0000-4000-8000-00000000000b', email: 'reclutador-b@e2e.test', password: PASSWORD_E2E, rol: 'reclutador', vacantes: [IDS.vacanteB] },
  clienteA: { id: 'd0000000-0000-4000-8000-0000000000c1', email: 'cliente@e2e.test', password: PASSWORD_E2E, rol: 'cliente', vacantes: [IDS.vacanteA] },
};

/** Martes 17-nov-2026 09:00 en Ciudad de México / Monterrey (UTC-6). */
export const INICIO_RELOJ = new Date('2026-11-17T15:00:00.000Z');
export const LINKS_SECRET_E2E = 'e2e-links-secret-de-al-menos-32-caracteres!!';
export const PIXEL_ID_E2E = '1234567890';
export const CALENDARIO_A = 'cal_agente_smart_e2e';
export const URL_WEB = 'https://369capitalhumano.com';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const jwtDe = (u: UsuarioSim, extra: Record<string, unknown> = {}) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, email: u.email, role: 'authenticated', aal: 'aal1', amr: [{ method: 'password', timestamp: 1 }], exp: 4102444800, ...extra })}.ZmlybWE`;
const usuarioAuth = (u: UsuarioSim) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {}, factors: [], created_at: '2026-01-01T00:00:00Z' });

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------
interface VacanteSim { id: string; cliente_id: string; slug: string; codigo: string; nombre: string; activa: boolean; agenda_modo: 'sistema' | 'whatsapp' }
interface VersionSim { vacante_id: string; version: number; reglas: ReglasVacante; creado_en: string; usuario_email: string; diff: unknown[] }
export type EstadoCitaSim = 'retenida' | 'confirmada' | 'expirada' | 'cancelada' | 'reprogramada' | 'asistio' | 'no_asistio';
export interface CitaSim {
  id: string; vacante_id: string; lead_id: string; inicio: string; fin: string; estado: EstadoCitaSim; retenida_hasta: string | null;
  reglas_version: number; asistio: boolean | null; evaluacion: unknown; zoho_event_uid: string | null; motivo: string | null;
}
export interface LeadSim {
  id: string; vacante_id: string; cliente_id: string; folio: string; nombre: string; nombre_pila: string; telefono: string; email: string | null;
  estado: 'pendiente' | 'verificado' | 'otp_bloqueado'; event_id: string; atribucion: Record<string, string>; respuestas: Record<string, unknown>;
  cita_id: string | null; creado_en: string;
}
interface OtpSim { id: string; lead_id: string; codigo: string; expira: Date; intentos: number; estado: 'vigente' | 'verificado' | 'bloqueado' | 'reemplazado' | 'vencido'; creado: Date }
export interface EventoOutbox { id: number; tipo: string; payload: Record<string, unknown> }
export interface MensajeSim { id: string; tipo: string; lead_id: string; cita_id: string | null; estado: 'pendiente' | 'enviado' | 'cancelado' | 'dead_letter'; programado: string; prioridad: number; texto?: string; intentos: number }
export interface TrabajoSim { id: string; cola: 'zoho' | 'capi'; accion: string; datos: Record<string, unknown>; intentos: number; visible_desde: number; estado: 'pendiente' | 'hecho' | 'dead_letter'; ultimo_error?: string }

export interface LlamadaFuncion { funcion: string; metodo: string; url: string; cuerpo: unknown; headers: Record<string, string> }
export type RespuestaFuncion = { estado: number; cuerpo?: unknown; headers?: Record<string, string> };
export type ManejadorFuncion = (l: LlamadaFuncion) => RespuestaFuncion | Promise<RespuestaFuncion>;

const MAX_INTENTOS_ZOHO = 3; // Z3: 1 intento + 2 reintentos → dead letter
const MAX_INTENTOS_CAPI = 5;
const backoffMs = (n: number) => Math.min(3600, 30 * 2 ** (n - 1)) * 1000;

const contenidoVacante = (slug: string): { preguntas: Pregunta[]; zona: string } | null => {
  try {
    const j = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'apps', 'web', 'vacantes', `${slug}.json`), 'utf8')) as { formulario: { preguntas: Pregunta[] }; zona_horaria: string };
    return { preguntas: j.formulario.preguntas, zona: j.zona_horaria };
  } catch {
    return null;
  }
};

const jsonDe = (req: Request): unknown => {
  try {
    return req.postDataJSON() as unknown;
  } catch {
    return null;
  }
};

const slotPublico = (s: Slot) => ({ inicio_utc: s.inicio, fin_utc: s.fin, inicio_local: s.inicioLocal, fecha: s.fecha, hora_local: s.horaLocal, disponibles: s.disponibles });

export class BackendSimulado {
  private ms = INICIO_RELOJ.getTime();
  readonly reloj = { now: () => new Date(this.ms) };
  readonly vacantes: VacanteSim[] = [
    { id: IDS.vacanteA, cliente_id: IDS.clienteA, slug: 'agente-smart', codigo: 'AS', nombre: 'Agente Smart', activa: true, agenda_modo: 'sistema' },
    { id: IDS.vacanteB, cliente_id: IDS.clienteB, slug: 'otra-vacante', codigo: 'OV', nombre: 'Operador Logístico', activa: true, agenda_modo: 'sistema' },
  ];
  readonly clientes = [{ id: IDS.clienteA, nombre: 'Telecom MTY' }, { id: IDS.clienteB, nombre: 'Logística Norte' }];
  readonly versiones: VersionSim[] = [];
  readonly leads: LeadSim[] = [];
  readonly otps: OtpSim[] = [];
  readonly citas: CitaSim[] = [];
  readonly outbox: EventoOutbox[] = [];
  readonly mensajes: MensajeSim[] = [];
  readonly trabajos: TrabajoSim[] = [];
  readonly ingesta: Array<Record<string, unknown>> = [];
  readonly contrasenas = new Map<string, string>();
  readonly recuperaciones: Array<{ email: string; redirect_to: string | null }> = [];
  private readonly registro: LlamadaFuncion[] = [];
  private readonly propios = new Map<string, ManejadorFuncion>();
  private cadena: Promise<void> = Promise.resolve();
  private cursorOutbox = 0;
  private secuenciaOutbox = 0;
  /** Desactiva el procesamiento automático de colas tras cada petición (para inspeccionar estados intermedios). */
  workersAutomaticos = true;

  constructor(private readonly proveedores: MocksProveedores) {
    for (const u of Object.values(USUARIOS)) this.contrasenas.set(u.email, u.password);
    // Vacante A: plantilla por defecto + calendario de Zoho (v1). Vacante B: también con su calendario.
    this.versiones.push({ vacante_id: IDS.vacanteA, version: 1, reglas: ReglasVacanteSchema.parse({ zoho_calendar_uid: CALENDARIO_A }), creado_en: '2026-11-13T18:00:00.000Z', usuario_email: USUARIOS.admin.email, diff: [] });
    this.versiones.push({ vacante_id: IDS.vacanteB, version: 1, reglas: ReglasVacanteSchema.parse({ zoho_calendar_uid: 'cal_otra_vacante_e2e' }), creado_en: '2026-11-13T18:00:00.000Z', usuario_email: USUARIOS.admin.email, diff: [] });
    // Una cita confirmada en la vacante B (para probar el aislamiento, E2E-11).
    const leadB = this.nuevoLead({ vacante: this.vacantes[1]!, nombre: 'Bruno Beltrán', telefono: '528187654321', email: null, event_id: uuidv7(this.reloj.now()), atribucion: {}, respuestas: {} });
    leadB.estado = 'verificado';
    this.citas.push({ id: 'cb000000-0000-4000-8000-0000000000c2', vacante_id: IDS.vacanteB, lead_id: leadB.id, inicio: '2026-11-18T16:00:00.000Z', fin: '2026-11-18T17:30:00.000Z', estado: 'confirmada', retenida_hasta: null, reglas_version: 1, asistio: null, evaluacion: null, zoho_event_uid: 'zev-b', motivo: null });
  }

  // ------------------------------------------------------------------ reloj y consultas de prueba
  avanzar(ms: number): void {
    this.ms += ms;
  }
  ahora(): Date {
    return this.reloj.now();
  }
  reglas(vacanteId: string): VersionSim {
    return this.versiones.filter((v) => v.vacante_id === vacanteId).sort((a, b) => b.version - a.version)[0]!;
  }
  /** Atajo de prueba: crea una versión nueva de la agenda de la vacante (como si la guardara un admin). */
  fijarAgenda(vacanteId: string, agenda: Partial<ReglasVacante['agenda']>): void {
    const actual = this.reglas(vacanteId);
    const reglas = ReglasVacanteSchema.parse({ ...actual.reglas, agenda: { ...actual.reglas.agenda, ...agenda } });
    this.versiones.push({ vacante_id: vacanteId, version: actual.version + 1, reglas, creado_en: this.ahora().toISOString(), usuario_email: USUARIOS.admin.email, diff: [] });
  }
  /** Atajo de prueba (F7.4): cambia `shared.vacantes.agenda_modo` como lo haría un admin. */
  fijarAgendaModo(vacanteId: string, modo: VacanteSim['agenda_modo']): void {
    this.vacantePor(vacanteId)!.agenda_modo = modo;
  }
  /** Atajo de prueba: siembra una cita (con su lead) sin pasar por el navegador. */
  sembrarCita(vacanteId: string, inicio: string, estado: EstadoCitaSim = 'confirmada', nombre = 'Sofía Ruiz'): CitaSim {
    const v = this.vacantePor(vacanteId)!;
    const lead = this.nuevoLead({ vacante: v, nombre, telefono: `5281${String(this.leads.length).padStart(8, '0')}`, email: null, event_id: uuidv7(this.ahora()), atribucion: {}, respuestas: {} });
    lead.estado = 'verificado';
    const dur = this.reglas(vacanteId).reglas.agenda.duracion_cita_min * 60_000;
    const cita: CitaSim = { id: uuidv7(this.ahora()), vacante_id: vacanteId, lead_id: lead.id, inicio, fin: new Date(Date.parse(inicio) + dur).toISOString(), estado, retenida_hasta: null, reglas_version: this.reglas(vacanteId).version, asistio: null, evaluacion: null, zoho_event_uid: null, motivo: null };
    this.citas.push(cita);
    lead.cita_id = cita.id;
    return cita;
  }
  slotsLibres(vacanteId: string): Slot[] {
    this.expirarRetenciones();
    return generarSlots(this.reglas(vacanteId).reglas.agenda, this.ocupacion(vacanteId), this.reloj).filter((s) => s.disponibles > 0);
  }
  cita(id: string): CitaSim | undefined {
    return this.citas.find((c) => c.id === id);
  }
  leadPorTelefono(telefono10: string): LeadSim | undefined {
    return [...this.leads].reverse().find((l) => l.telefono === `52${telefono10}`);
  }
  llamadas(funcion?: string): LlamadaFuncion[] {
    return funcion ? this.registro.filter((l) => l.funcion === funcion) : [...this.registro];
  }
  /** Sobrescribe la respuesta de una edge function (fallas puntuales: 5xx, 401, 409…). */
  responder(funcion: string, m: ManejadorFuncion): void {
    this.propios.set(funcion, m);
  }
  eventos(tipo?: string): EventoOutbox[] {
    return tipo ? this.outbox.filter((e) => e.tipo === tipo) : [...this.outbox];
  }
  /** Firma un link de gestión igual que Comunicación (token → /cita/?t=). */
  linkGestion(citaId: string, accion: 'cancelar' | 'reprogramar', expiraEn?: string): Promise<string> {
    const c = this.cita(citaId);
    return firmarLinkGestion({ citaId, accion, expiraEn: expiraEn ?? c?.inicio ?? new Date(this.ms + 86_400_000).toISOString() }, LINKS_SECRET_E2E);
  }

  // ------------------------------------------------------------------ conexión con el navegador
  /** Enruta Supabase (*.supabase.co: functions, auth, rest) de un contexto de navegador a este backend. */
  async conectar(context: BrowserContext): Promise<void> {
    await context.route((u) => u.hostname.endsWith('.supabase.co'), (route, req) => this.atender(route, req));
  }

  private async atender(route: Route, req: Request): Promise<void> {
    const url = new URL(req.url());
    const origen = req.headers()['origin'] ?? '*';
    const cors = { 'access-control-allow-origin': origen, 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-credentials': 'true', vary: 'Origin' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let r: RespuestaFuncion;
    if (url.pathname.startsWith('/functions/v1/')) r = await this.funcion(url, req);
    else if (url.pathname.startsWith('/auth/v1/')) r = this.auth(url, req);
    else if (url.pathname.startsWith('/rest/v1/')) r = await this.rest(url, req);
    else r = { estado: 404, cuerpo: { error: 'ruta_desconocida' } };
    await route.fulfill({ status: r.estado, contentType: 'application/json', headers: { ...cors, ...r.headers }, body: r.cuerpo === undefined ? '' : JSON.stringify(r.cuerpo) }).catch(() => undefined);
    if (this.workersAutomaticos && req.method() !== 'GET') void this.procesarColas();
  }

  private async funcion(url: URL, req: Request): Promise<RespuestaFuncion> {
    const ruta = url.pathname.slice('/functions/v1/'.length);
    const funcion = ruta.split('/')[0] ?? '';
    let cuerpo: unknown = null;
    const texto = req.postData();
    if (texto) {
      try {
        cuerpo = JSON.parse(texto);
      } catch {
        cuerpo = texto;
      }
    }
    const l: LlamadaFuncion = { funcion, metodo: req.method(), url: req.url(), cuerpo, headers: req.headers() };
    this.registro.push(l);
    const propio = this.propios.get(funcion);
    if (propio) return propio(l);
    const corr = { 'x-correlation-id': `e2e-${this.registro.length}` };
    const conCorr = (r: RespuestaFuncion): RespuestaFuncion => ({ ...r, headers: { ...corr, ...r.headers } });
    switch (funcion) {
      case 'citas-api': return conCorr(this.citasApi(url));
      case 'postular': return conCorr(await this.postular(cuerpo, l.headers));
      case 'verificar-otp': return conCorr(ruta.replace(/\/+$/, '').endsWith('/reenviar') ? await this.reenviar(cuerpo) : await this.verificar(cuerpo));
      case 'gestionar-cita': return conCorr(await this.gestionar(cuerpo));
      case 'panel-reglas': return conCorr(this.panelReglas(cuerpo, l.headers));
      case 'tracking-ingest': {
        if (cuerpo && typeof cuerpo === 'object') this.ingesta.push(cuerpo as Record<string, unknown>);
        return { estado: 202, cuerpo: { ok: true } };
      }
      case 'contacto-b2b': return conCorr({ estado: 201, cuerpo: { id: uuidv7(this.ahora()) } });
      default: return { estado: 404, cuerpo: { error: 'funcion_desconocida' } };
    }
  }

  // ------------------------------------------------------------------ citas
  private ocupacion(vacanteId: string) {
    return this.citas.filter((c) => c.vacante_id === vacanteId && (c.estado === 'confirmada' || c.estado === 'retenida')).map((c) => ({ inicio: c.inicio, fin: c.fin }));
  }
  /** C12: retenciones vencidas → expirada (libera el slot). */
  private expirarRetenciones(): void {
    for (const c of this.citas) if (c.estado === 'retenida' && c.retenida_hasta && Date.parse(c.retenida_hasta) <= this.ms) {
      c.estado = 'expirada';
      c.motivo = 'ttl';
    }
  }
  private vacantePor(idOSlug: string | null): VacanteSim | undefined {
    return this.vacantes.find((v) => v.id === idOSlug || v.slug === idOSlug);
  }

  private citasApi(url: URL): RespuestaFuncion {
    const v = this.vacantePor(url.searchParams.get('vacante'));
    if (!v) return { estado: 404, cuerpo: { error: 'VACANTE_NO_ENCONTRADA' } };
    const reglas = this.reglas(v.id);
    return {
      estado: 200,
      headers: { 'cache-control': 'public, max-age=10' },
      // Igual que obtenerSlotsCaso: en modo whatsapp (F7.4) no hay slots del sistema y el modo va explícito.
      cuerpo: {
        vacante_id: v.id, agenda_modo: v.agenda_modo, zona_horaria: reglas.reglas.agenda.zona_horaria, reglas_version: reglas.version,
        slots: v.agenda_modo === 'sistema' ? this.slotsLibres(v.id).map(slotPublico) : [],
      },
    };
  }

  private retener(v: VacanteSim, leadId: string, inicio: string): { ok: true; cita: CitaSim } | { ok: false; error: string } {
    this.expirarRetenciones();
    const r = this.reglas(v.id);
    if (v.agenda_modo !== 'sistema') return { ok: false, error: 'SLOT_INVALIDO' };
    if (this.citas.some((c) => c.lead_id === leadId && c.vacante_id === v.id && c.estado === 'confirmada')) return { ok: false, error: 'SLOT_INVALIDO' };
    const p = puedeReservar(r.reglas.agenda, this.ocupacion(v.id), inicio, this.reloj);
    if (!p.ok) return { ok: false, error: p.error };
    const cita: CitaSim = {
      id: uuidv7(this.ahora()), vacante_id: v.id, lead_id: leadId, inicio: p.value.inicio, fin: p.value.fin, estado: 'retenida',
      retenida_hasta: new Date(this.ms + r.reglas.agenda.ttl_retencion_min * 60_000).toISOString(), reglas_version: r.version, asistio: null, evaluacion: null, zoho_event_uid: null, motivo: null,
    };
    this.citas.push(cita);
    return { ok: true, cita };
  }

  private liberar(citaId: string | null, motivo: string): void {
    const c = citaId ? this.cita(citaId) : undefined;
    if (c?.estado === 'retenida') {
      c.estado = 'expirada';
      c.motivo = motivo;
    }
  }

  private publicar(tipo: string, payload: Record<string, unknown>): void {
    this.outbox.push({ id: ++this.secuenciaOutbox, tipo, payload });
  }

  // ------------------------------------------------------------------ captación
  private nuevoLead(d: { vacante: VacanteSim; nombre: string; telefono: string; email: string | null; event_id: string; atribucion: Record<string, string>; respuestas: Record<string, unknown> }): LeadSim {
    const lead: LeadSim = {
      id: uuidv7(this.ahora()), vacante_id: d.vacante.id, cliente_id: d.vacante.cliente_id, folio: generarFolio(), nombre: d.nombre, nombre_pila: d.nombre.split(/\s+/)[0] ?? d.nombre,
      telefono: d.telefono, email: d.email, estado: 'pendiente', event_id: d.event_id, atribucion: d.atribucion, respuestas: d.respuestas, cita_id: null, creado_en: this.ahora().toISOString(),
    };
    this.leads.push(lead);
    return lead;
  }

  private envios(telefono: string): number {
    const ids = new Set(this.leads.filter((l) => l.telefono === telefono).map((l) => l.id));
    return this.otps.filter((o) => ids.has(o.lead_id) && this.ms - o.creado.getTime() < 3_600_000).length;
  }

  private emitirOtp(lead: LeadSim): OtpSim {
    for (const o of this.otps) if (o.lead_id === lead.id && o.estado === 'vigente') o.estado = 'reemplazado';
    const codigo = String(100_000 + Math.floor(Math.random() * 900_000));
    const otp: OtpSim = { id: uuidv7(this.ahora()), lead_id: lead.id, codigo, expira: new Date(this.ms + OTP.TTL_MIN * 60_000), intentos: 0, estado: 'vigente', creado: this.ahora() };
    this.otps.push(otp);
    // Cola de comunicación, prioridad 0 (M9). El código viaja cifrado en la real; aquí solo lo ve el "worker".
    this.mensajes.push({ id: uuidv7(this.ahora()), tipo: 'otp', lead_id: lead.id, cita_id: lead.cita_id, estado: 'pendiente', programado: this.ahora().toISOString(), prioridad: 0, texto: `Tu código de verificación de 369 Capital Humano es ${codigo}. Vence en 10 minutos.`, intentos: 0 });
    return otp;
  }

  private error(estado: number, cuerpo: Record<string, unknown>, headers?: Record<string, string>): RespuestaFuncion {
    const codigo = String(cuerpo.error);
    if (['SLOT_LLENO', 'CUPO_DIARIO', 'SLOT_INVALIDO', 'RETENCION_EXPIRADA'].includes(codigo)) cuerpo.elegir_otro_horario = true;
    if (estado >= 500) cuerpo.fallback_whatsapp = true;
    return { estado, cuerpo, headers };
  }

  private async postular(entrada: unknown, headers: Record<string, string>): Promise<RespuestaFuncion> {
    if (!(headers['content-type'] ?? '').startsWith('application/json')) return this.error(415, { error: 'TIPO_NO_SOPORTADO' });
    const slug = (entrada as { vacante?: unknown } | null)?.vacante;
    const contenido = typeof slug === 'string' ? contenidoVacante(slug) : null;
    const vacante = typeof slug === 'string' ? this.vacantePor(slug) : undefined;
    if (!contenido || !vacante) return this.error(404, { error: 'VACANTE_NO_ENCONTRADA' });
    const v = validarPostulacion(entrada, contenido.preguntas);
    if (!v.ok) return this.error(v.error.codigo === 'ANTIBOT_REQUERIDO' ? 403 : 422, { error: v.error.codigo, campos: v.error.campos });
    const p = v.value;
    if (p.turnstileToken === 'invalido') return this.error(403, { error: 'ANTIBOT_INVALIDO' });
    const limite = evaluarLimiteEnvio({ porTelefono: this.envios(p.telefonoE164), porIp: 0 });
    if (!limite.ok) return this.error(429, { error: limite.error }, { 'retry-after': '3600' });
    // P7: si el código va por WhatsApp, Evolution confirma que el número existe ANTES de retener (llamada real al mock de proveedores).
    if (p.canalOtp === 'whatsapp') {
      const existe = await this.existeEnWhatsApp(p.telefonoE164);
      if (existe === null) return this.error(503, { error: 'VERIFICADOR_NO_DISPONIBLE' });
      if (!existe) return this.error(422, { error: 'WHATSAPP_INVALIDO' });
    }
    if (this.leads.some((l) => l.event_id === p.eventId)) return this.error(409, { error: 'EVENTO_DUPLICADO' });

    // "Transacción": dedupe (P5) → retención (lock) → OTP → LeadCreado.
    const hace30d = this.ms - 30 * 86_400_000;
    const existente = [...this.leads].reverse().find((l) => l.telefono === p.telefonoE164 && l.vacante_id === vacante.id && Date.parse(l.creado_en) >= hace30d);
    if (existente?.estado === 'verificado') return this.error(409, { error: 'YA_POSTULADO', folio: existente.folio });
    const atribucion = Object.fromEntries(Object.entries(p.atribucion).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
    const lead = existente ?? this.nuevoLead({ vacante, nombre: p.nombre, telefono: p.telefonoE164, email: p.email, event_id: p.eventId, atribucion, respuestas: p.respuestas });
    const ret = this.retener(vacante, lead.id, p.slotInicio);
    if (!ret.ok) {
      if (!existente) this.leads.splice(this.leads.indexOf(lead), 1); // rollback
      return this.error(409, { error: ret.error });
    }
    if (existente) {
      this.liberar(existente.cita_id, 'reemplazada');
      existente.estado = 'pendiente';
    }
    lead.cita_id = ret.cita.id;
    const otp = this.emitirOtp(lead);
    if (!existente) {
      this.publicar('LeadCreado', { lead_id: lead.id, vacante_id: vacante.id, cliente_id: vacante.cliente_id, folio: lead.folio, event_id: p.eventId, visitor_id: atribucion.visitor_id ?? null, origen: atribucion.origen ?? atribucion.utm_source ?? null });
    }
    return {
      estado: 201,
      cuerpo: {
        lead_id: lead.id, folio: lead.folio, reutilizado: !!existente,
        cita: { id: ret.cita.id, inicio: ret.cita.inicio, retenida_hasta: ret.cita.retenida_hasta },
        otp: { expira_en: otp.expira.toISOString(), reenvios_restantes: limite.value.restantesTelefono, canal: p.canalOtp },
      },
    };
  }

  private async verificar(entrada: unknown): Promise<RespuestaFuncion> {
    const e = entrada as { lead_id?: unknown; codigo?: unknown } | null;
    if (typeof e?.lead_id !== 'string' || typeof e.codigo !== 'string' || !/^\d{6}$/.test(e.codigo)) return this.error(422, { error: 'FORMATO_INVALIDO', campos: [] });
    this.expirarRetenciones();
    const lead = this.leads.find((l) => l.id === e.lead_id);
    if (!lead) return this.error(404, { error: 'NO_ENCONTRADO' });
    if (lead.estado === 'verificado') return this.error(409, { error: 'YA_VERIFICADO', folio: lead.folio });
    const otp = [...this.otps].reverse().find((o) => o.lead_id === lead.id);
    if (!otp) return this.error(404, { error: 'NO_ENCONTRADO' });
    // Comparación por "hash": el dominio compara en tiempo constante dos cadenas; aquí el código hace de hash.
    const intento = evaluarIntento({ codigoHash: otp.codigo, expiraEn: otp.expira, intentos: otp.intentos, estado: otp.estado }, e.codigo, this.ahora());
    switch (intento.resultado) {
      case 'INCORRECTO':
        otp.intentos = intento.intentos;
        return this.error(422, { error: 'OTP_INCORRECTO', intentos_restantes: intento.restantes });
      case 'BLOQUEADO':
        if (otp.estado !== 'bloqueado') {
          otp.intentos = intento.intentos;
          otp.estado = 'bloqueado';
          lead.estado = 'otp_bloqueado';
          this.liberar(lead.cita_id, 'OTP_BLOQUEADO'); // O2: la retención se libera
          lead.cita_id = null;
        }
        return this.error(423, { error: 'OTP_BLOQUEADO' });
      case 'VENCIDO':
      case 'NO_VIGENTE':
        if (otp.estado === 'vigente') otp.estado = 'vencido';
        return this.error(410, { error: 'OTP_VENCIDO', puede_reenviar: evaluarLimiteEnvio({ porTelefono: this.envios(lead.telefono), porIp: 0 }).ok });
      case 'YA_VERIFICADO':
        return this.error(409, { error: 'YA_VERIFICADO', folio: lead.folio });
      case 'CORRECTO':
        break;
    }
    otp.estado = 'verificado';
    const cita = lead.cita_id ? this.cita(lead.cita_id) : undefined;
    if (!cita || cita.estado !== 'retenida') {
      lead.cita_id = null;
      return this.error(409, { error: 'RETENCION_EXPIRADA' });
    }
    cita.estado = 'confirmada';
    cita.retenida_hasta = null;
    lead.estado = 'verificado';
    this.publicar('WhatsAppVerificado', { lead_id: lead.id, vacante_id: lead.vacante_id, cliente_id: lead.cliente_id, event_id: uuidv7(this.ahora()) });
    this.publicar('CitaConfirmada', { cita_id: cita.id, lead_id: lead.id, vacante_id: cita.vacante_id, cliente_id: lead.cliente_id, inicio: cita.inicio, fin: cita.fin, folio: lead.folio, nombre_pila: lead.nombre_pila, event_id: uuidv7(this.ahora()), reglas_version: cita.reglas_version });
    return { estado: 200, cuerpo: { folio: lead.folio, nombre_pila: lead.nombre_pila, cita: { id: cita.id, inicio: cita.inicio, fin: cita.fin } } };
  }

  private async reenviar(entrada: unknown): Promise<RespuestaFuncion> {
    const leadId = (entrada as { lead_id?: unknown } | null)?.lead_id;
    const canal = (entrada as { canal?: unknown } | null)?.canal ?? 'whatsapp';
    const lead = this.leads.find((l) => l.id === leadId);
    if (!lead) return this.error(404, { error: 'NO_ENCONTRADO' });
    if (lead.estado === 'verificado') return this.error(409, { error: 'YA_VERIFICADO', folio: lead.folio });
    if (lead.estado === 'otp_bloqueado') return this.error(423, { error: 'OTP_BLOQUEADO' });
    const limite = evaluarLimiteEnvio({ porTelefono: this.envios(lead.telefono), porIp: 0 });
    if (!limite.ok) return this.error(429, { error: limite.error }, { 'retry-after': '3600' });
    this.expirarRetenciones();
    const cita = lead.cita_id ? this.cita(lead.cita_id) : undefined;
    if (!cita || cita.estado !== 'retenida') {
      lead.cita_id = null;
      return this.error(409, { error: 'RETENCION_EXPIRADA' });
    }
    const otp = this.emitirOtp(lead);
    return { estado: 200, cuerpo: { expira_en: otp.expira.toISOString(), reenvios_restantes: limite.value.restantesTelefono, canal, retencion_expira_en: cita.retenida_hasta } };
  }

  // ------------------------------------------------------------------ gestión de la cita (CIT-11, C15)
  private async gestionar(entrada: unknown): Promise<RespuestaFuncion> {
    const e = entrada as { token?: unknown; operacion?: unknown; nuevo_inicio?: unknown } | null;
    if (typeof e?.token !== 'string') return this.error(400, { error: 'CUERPO_INVALIDO' });
    const link = await verificarLinkGestion(e.token, LINKS_SECRET_E2E, this.reloj);
    if (!link.ok) return this.error(401, { error: link.error });
    const c = this.cita(link.value.citaId);
    if (!c) return this.error(404, { error: 'NO_ENCONTRADA' });
    const v = this.vacantePor(c.vacante_id)!;
    const zona = this.reglas(v.id).reglas.agenda.zona_horaria;
    if (e.operacion === 'consultar') {
      const cita = { cita_id: c.id, vacante_id: c.vacante_id, estado: c.estado, inicio_utc: c.inicio, fin_utc: c.fin, inicio_local: c.inicio, zona_horaria: zona };
      if (link.value.accion !== 'reprogramar' || c.estado !== 'confirmada') return { estado: 200, cuerpo: { accion: link.value.accion, cita } };
      return { estado: 200, cuerpo: { accion: link.value.accion, cita, slots: this.slotsLibres(v.id).filter((s) => s.inicio !== c.inicio).map(slotPublico) } };
    }
    if (c.estado !== 'confirmada') return this.error(409, { error: 'TRANSICION_INVALIDA' });
    if (link.value.accion === 'cancelar') {
      c.estado = 'cancelada';
      c.motivo = 'candidato';
      this.publicar('CitaCancelada', { cita_id: c.id, lead_id: c.lead_id, vacante_id: c.vacante_id, motivo: 'candidato' });
      return { estado: 200, cuerpo: { accion: 'cancelar', cita_id: c.id, estado: 'cancelada' } };
    }
    if (typeof e.nuevo_inicio !== 'string') return this.error(400, { error: 'NUEVO_INICIO_REQUERIDO' });
    c.estado = 'reprogramada'; // se libera para que no cuente contra sí misma
    const ret = this.retener(v, `${c.lead_id}`, e.nuevo_inicio);
    if (!ret.ok) {
      c.estado = 'confirmada'; // rollback
      return this.error(409, { error: ret.error });
    }
    Object.assign(ret.cita, { estado: 'confirmada', retenida_hasta: null });
    this.publicar('CitaReprogramada', { cita_id: ret.cita.id, cita_anterior_id: c.id, lead_id: c.lead_id, vacante_id: c.vacante_id });
    return { estado: 200, cuerpo: { accion: 'reprogramar', cita_id: ret.cita.id, cita_anterior_id: c.id, estado: 'confirmada', inicio_utc: ret.cita.inicio, fin_utc: ret.cita.fin } };
  }

  // ------------------------------------------------------------------ Supabase Auth
  usuarioDeToken(auth: string | undefined): UsuarioSim | null {
    const t = /^Bearer (.+)$/.exec(auth ?? '')?.[1];
    if (!t) return null;
    try {
      const sub = (JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string }).sub;
      return Object.values(USUARIOS).find((u) => u.id === sub) ?? null;
    } catch {
      return null;
    }
  }

  private auth(url: URL, req: Request): RespuestaFuncion {
    const ruta = url.pathname.replace('/auth/v1', '');
    const cuerpo = jsonDe(req) as Record<string, string> | null;
    if (ruta === '/token') {
      const u = Object.values(USUARIOS).find((x) => x.email === cuerpo?.email);
      if (!u || this.contrasenas.get(u.email) !== cuerpo?.password) return { estado: 400, cuerpo: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
      return { estado: 200, cuerpo: { access_token: jwtDe(u), token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: `r-${u.id}`, user: usuarioAuth(u) } };
    }
    const u = this.usuarioDeToken(req.headers()['authorization']);
    if (ruta === '/user' && req.method() === 'GET') return u ? { estado: 200, cuerpo: usuarioAuth(u) } : { estado: 401, cuerpo: { code: 401, msg: 'invalid JWT' } };
    if (ruta === '/user' && req.method() === 'PUT') {
      if (!u) return { estado: 401, cuerpo: { code: 401, msg: 'invalid JWT' } };
      const pw = cuerpo?.password ?? '';
      if (pw.length < 12 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return { estado: 422, cuerpo: { code: 422, error_code: 'weak_password', msg: 'Password is too weak' } };
      if (pw === this.contrasenas.get(u.email)) return { estado: 422, cuerpo: { code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' } };
      this.contrasenas.set(u.email, pw);
      return { estado: 200, cuerpo: usuarioAuth(u) };
    }
    if (ruta === '/recover') {
      this.recuperaciones.push({ email: cuerpo?.email ?? '', redirect_to: url.searchParams.get('redirect_to') });
      return { estado: 200, cuerpo: {} };
    }
    if (ruta === '/logout') return { estado: 204 };
    return { estado: 404, cuerpo: {} };
  }

  // ------------------------------------------------------------------ PostgREST con RLS simulado (S1/DSH-06)
  private visibles(u: UsuarioSim | null): Set<string> {
    if (!u) return new Set();
    return new Set(u.rol === 'admin' ? this.vacantes.map((v) => v.id) : u.vacantes);
  }
  private puedeOperar(u: UsuarioSim | null, vacanteId: string): boolean {
    return !!u && (u.rol === 'admin' || (u.rol === 'reclutador' && u.vacantes.includes(vacanteId)));
  }

  private tabla(nombre: string, u: UsuarioSim | null): Array<Record<string, unknown>> {
    const vis = this.visibles(u);
    const zona = (id: string) => this.reglas(id).reglas.agenda.zona_horaria;
    const diaLocal = (iso: string, z: string) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    switch (nombre) {
      case 'usuarios_roles': return u ? [{ user_id: u.id, rol: u.rol }] : [];
      case 'usuarios_vacantes': return u ? u.vacantes.map((v) => ({ user_id: u.id, vacante_id: v })) : [];
      case 'vacantes': return this.vacantes.filter((v) => vis.has(v.id)).map((v) => ({ ...v }));
      case 'clientes': return this.clientes.filter((c) => this.vacantes.some((v) => v.cliente_id === c.id && vis.has(v.id)));
      case 'vacantes_reglas': return this.versiones.filter((v) => vis.has(v.vacante_id)).map((v) => ({ vacante_id: v.vacante_id, version: v.version, reglas: v.reglas, creado_en: v.creado_en }));
      case 'citas': return this.citas.filter((c) => vis.has(c.vacante_id)).map((c) => ({ ...c, dia_local: diaLocal(c.inicio, zona(c.vacante_id)) }));
      // Minimización: el panel solo pide folio y nombre de pila (el teléfono nunca se expone en la simulación).
      case 'leads': return this.leads.filter((l) => vis.has(l.vacante_id)).map((l) => ({ id: l.id, vacante_id: l.vacante_id, folio: l.folio, nombre_pila: l.nombre_pila }));
      case 'contrataciones': return [];
      case 'api_kpis_diarios':
      case 'api_funnel': return [];
      default: return [];
    }
  }

  private filtrar(filas: Array<Record<string, unknown>>, q: URLSearchParams): Array<Record<string, unknown>> {
    let out = filas;
    for (const [k, v] of q) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      const i = v.indexOf('.');
      const op = v.slice(0, i);
      const val = v.slice(i + 1);
      const s = (x: unknown) => (x === null || x === undefined ? 'null' : String(x));
      out = out.filter((f) => {
        const x = s(f[k]);
        switch (op) {
          case 'eq': return x === val;
          case 'neq': return x !== val;
          case 'gte': return x >= val;
          case 'lte': return x <= val;
          case 'in': return val.replace(/^\(|\)$/g, '').split(',').map((y) => y.replace(/^"|"$/g, '')).includes(x);
          case 'is': return x === val;
          default: return true;
        }
      });
    }
    const orden = q.get('order');
    if (orden) {
      const [col, dir] = orden.split(',')[0]!.split('.') as [string, string | undefined];
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const limite = Number(q.get('limit') ?? NaN);
    return Number.isFinite(limite) ? out.slice(0, limite) : out;
  }

  private async rest(url: URL, req: Request): Promise<RespuestaFuncion> {
    const u = this.usuarioDeToken(req.headers()['authorization']);
    const ruta = url.pathname.replace('/rest/v1/', '');
    if (ruta.startsWith('rpc/')) return this.rpc(ruta.slice(4), (jsonDe(req) ?? {}) as Record<string, unknown>, u);
    if (!u) return { estado: 200, cuerpo: [] }; // anon: RLS deny-by-default (S2) → sin filas
    return { estado: 200, cuerpo: this.filtrar(this.tabla(ruta, u), url.searchParams) };
  }

  readonly rpcs: Array<{ nombre: string; cuerpo: Record<string, unknown>; usuario: string | null }> = [];
  private rpc(nombre: string, cuerpo: Record<string, unknown>, u: UsuarioSim | null): RespuestaFuncion {
    this.rpcs.push({ nombre, cuerpo, usuario: u?.email ?? null });
    const denegado = { estado: 403, cuerpo: { code: '42501', message: 'PERMISO_DENEGADO' } };
    if (nombre === 'historial_reglas') {
      const vid = String(cuerpo.p_vacante);
      if (!this.visibles(u).has(vid)) return { estado: 200, cuerpo: [] };
      return { estado: 200, cuerpo: this.versiones.filter((v) => v.vacante_id === vid).sort((a, b) => b.version - a.version).map((v) => ({ version: v.version, usuario_email: v.usuario_email, creado_en: v.creado_en, diff: v.diff })) };
    }
    if (nombre === 'registrar_asistencia') {
      const c = this.cita(String(cuerpo.p_cita));
      if (!c || !this.visibles(u).has(c.vacante_id)) return { estado: 400, cuerpo: { code: 'P0001', message: 'NO_ENCONTRADA' } };
      if (!this.puedeOperar(u, c.vacante_id)) return denegado;
      if (c.estado !== 'confirmada') return { estado: 400, cuerpo: { code: 'P0001', message: 'TRANSICION_INVALIDA' } };
      c.estado = cuerpo.p_asistio ? 'asistio' : 'no_asistio';
      c.asistio = !!cuerpo.p_asistio;
      c.evaluacion = cuerpo.p_evaluacion ?? null;
      const event_id = uuidv7(this.ahora());
      const lead = this.leads.find((l) => l.id === c.lead_id);
      this.publicar('AsistenciaRegistrada', { cita_id: c.id, lead_id: c.lead_id, vacante_id: c.vacante_id, cliente_id: lead?.cliente_id, asistio: c.asistio, event_id });
      return { estado: 200, cuerpo: { cita_id: c.id, estado: c.estado, event_id } };
    }
    if (nombre === 'registrar_contratacion') {
      const c = this.cita(String(cuerpo.p_cita));
      if (!c || !this.puedeOperar(u, c.vacante_id)) return denegado;
      return { estado: 200, cuerpo: { cita_id: c.id, estado: cuerpo.p_entregado ? 'entregado' : 'contratado' } };
    }
    return { estado: 404, cuerpo: { message: 'rpc desconocida' } };
  }

  // ------------------------------------------------------------------ panel-reglas (DSH-04, S3, S4)
  private panelReglas(entrada: unknown, headers: Record<string, string>): RespuestaFuncion {
    const u = this.usuarioDeToken(headers['authorization']);
    if (!u) return { estado: 401, cuerpo: { error: 'SIN_SESION' } };
    const e = entrada as { operacion?: string; datos?: { vacante_id?: string; version_base?: number; reglas?: unknown } } | null;
    if (e?.operacion !== 'guardar_reglas') return { estado: 400, cuerpo: { error: 'OPERACION_INVALIDA' } };
    const vid = e.datos?.vacante_id ?? '';
    if (!this.vacantePor(vid)) return { estado: 404, cuerpo: { error: 'NO_ENCONTRADA' } };
    if (!this.puedeOperar(u, vid)) return { estado: 403, cuerpo: { error: 'PERMISO_DENEGADO' } };
    const r = ReglasVacanteSchema.safeParse(e.datos?.reglas);
    if (!r.success) return { estado: 422, cuerpo: { error: 'REGLAS_INVALIDAS', problemas: r.error.issues.map((i) => ({ ruta: i.path.join('.'), mensaje: i.message })) } };
    const actual = this.reglas(vid);
    if ((e.datos?.version_base ?? -1) !== actual.version) return { estado: 409, cuerpo: { error: 'VERSION_CONFLICTO' } };
    if (u.rol !== 'admin' && (r.data.zoho_calendar_uid ?? null) !== (actual.reglas.zoho_calendar_uid ?? null)) return { estado: 403, cuerpo: { error: 'PERMISO_DENEGADO' } };
    if (JSON.stringify(r.data) === JSON.stringify(actual.reglas)) return { estado: 200, cuerpo: { vacante_id: vid, version: actual.version, reglas: actual.reglas, diff: [], sin_cambios: true } };
    const nueva: VersionSim = { vacante_id: vid, version: actual.version + 1, reglas: r.data, creado_en: this.ahora().toISOString(), usuario_email: u.email, diff: [] };
    this.versiones.push(nueva);
    return { estado: 200, cuerpo: { vacante_id: vid, version: nueva.version, reglas: nueva.reglas, diff: [], sin_cambios: false } };
  }

  // ------------------------------------------------------------------ proveedores (HTTP real al servidor de mocks)
  private async http(ruta: string, init: { metodo: string; cuerpo?: unknown; headers?: Record<string, string> }): Promise<{ estado: number; cuerpo: unknown } | null> {
    try {
      const r = await fetch(`${this.proveedores.url}${ruta}`, { method: init.metodo, headers: { 'content-type': 'application/json', ...init.headers }, body: init.cuerpo === undefined ? undefined : JSON.stringify(init.cuerpo) });
      const texto = await r.text();
      return { estado: r.status, cuerpo: texto ? (JSON.parse(texto) as unknown) : null };
    } catch {
      return null;
    }
  }

  private async existeEnWhatsApp(telefono: string): Promise<boolean | null> {
    const r = await this.http('/evolution/chat/whatsappNumbers/e2e', { metodo: 'POST', cuerpo: { numbers: [telefono] }, headers: { apikey: 'e2e' } });
    if (!r || r.estado >= 500) return null;
    return Array.isArray(r.cuerpo) && (r.cuerpo[0] as { exists?: boolean } | undefined)?.exists === true;
  }

  /** Corre los "workers": outbox → colas; luego Comunicación, Zoho y CAPI. Serializado; se puede esperar. */
  procesarColas(): Promise<void> {
    this.cadena = this.cadena.then(() => this.ciclo()).catch(() => undefined);
    return this.cadena;
  }

  private async ciclo(): Promise<void> {
    await this.consumirOutbox();
    await this.enviarMensajes();
    await this.correrTrabajos();
  }

  private trabajo(cola: TrabajoSim['cola'], accion: string, datos: Record<string, unknown>): void {
    this.trabajos.push({ id: uuidv7(this.ahora()), cola, accion, datos, intentos: 0, visible_desde: this.ms, estado: 'pendiente' });
  }

  private async consumirOutbox(): Promise<void> {
    while (this.cursorOutbox < this.outbox.length) {
      const ev = this.outbox[this.cursorOutbox++]!;
      const p = ev.payload;
      const lead = this.leads.find((l) => l.id === p.lead_id);
      const conConsentimiento = !!lead?.atribucion.visitor_id; // política: sin cookies no se envía nada a terceros
      switch (ev.tipo) {
        case 'LeadCreado':
          if (conConsentimiento) this.trabajo('capi', 'Lead', { event_id: p.event_id, lead_id: p.lead_id, vacante_id: p.vacante_id, action_source: 'website' });
          break;
        case 'CitaConfirmada': {
          const c = this.cita(String(p.cita_id))!;
          if (conConsentimiento) this.trabajo('capi', 'Schedule', { event_id: p.event_id, lead_id: p.lead_id, vacante_id: p.vacante_id, action_source: 'website' });
          this.trabajo('zoho', 'crear', { cita_id: c.id });
          const cancelar = await this.linkGestion(c.id, 'cancelar');
          const reprogramar = await this.linkGestion(c.id, 'reprogramar');
          this.mensajes.push({ id: uuidv7(this.ahora()), tipo: 'confirmacion', lead_id: c.lead_id, cita_id: c.id, estado: 'pendiente', programado: this.ahora().toISOString(), prioridad: 5, intentos: 0, texto: `Tu entrevista quedó confirmada (folio ${lead?.folio}). Cancelar: ${URL_WEB}/cita/?t=${cancelar} · Reprogramar: ${URL_WEB}/cita/?t=${reprogramar}` });
          const recs = this.reglas(c.vacante_id).reglas.mensajes.recordatorios;
          for (const [tipo, r] of [['recordatorio_24h', recs.h24], ['recordatorio_2h', recs.h2]] as const) {
            if (r.activo) this.mensajes.push({ id: uuidv7(this.ahora()), tipo, lead_id: c.lead_id, cita_id: c.id, estado: 'pendiente', programado: new Date(Date.parse(c.inicio) - r.horas_antes * 3_600_000).toISOString(), prioridad: 5, intentos: 0, texto: `Recordatorio de tu entrevista (folio ${lead?.folio}).` });
          }
          break;
        }
        case 'CitaCancelada':
          for (const m of this.mensajes) if (m.cita_id === p.cita_id && m.estado === 'pendiente' && m.tipo.startsWith('recordatorio')) m.estado = 'cancelado'; // M7
          this.trabajo('zoho', 'borrar', { cita_id: p.cita_id });
          this.mensajes.push({ id: uuidv7(this.ahora()), tipo: 'cancelacion', lead_id: String(p.lead_id), cita_id: String(p.cita_id), estado: 'pendiente', programado: this.ahora().toISOString(), prioridad: 5, intentos: 0, texto: 'Tu entrevista fue cancelada.' });
          break;
        case 'CitaReprogramada':
          for (const m of this.mensajes) if (m.cita_id === p.cita_anterior_id && m.estado === 'pendiente' && m.tipo.startsWith('recordatorio')) m.estado = 'cancelado';
          this.trabajo('zoho', 'borrar', { cita_id: p.cita_anterior_id });
          this.trabajo('zoho', 'crear', { cita_id: p.cita_id });
          break;
        case 'AsistenciaRegistrada':
          if (p.asistio) {
            this.trabajo('capi', 'CompleteRegistration', { event_id: p.event_id, lead_id: p.lead_id, vacante_id: p.vacante_id, action_source: 'system_generated' }); // T6
            this.mensajes.push({ id: uuidv7(this.ahora()), tipo: 'agradecimiento', lead_id: String(p.lead_id), cita_id: String(p.cita_id), estado: 'pendiente', programado: this.ahora().toISOString(), prioridad: 5, intentos: 0, texto: 'Gracias por asistir a tu entrevista.' });
          }
          break;
        default:
          break;
      }
    }
  }

  private async enviarMensajes(): Promise<void> {
    const listos = this.mensajes.filter((m) => m.estado === 'pendiente' && Date.parse(m.programado) <= this.ms).sort((a, b) => a.prioridad - b.prioridad);
    for (const m of listos) {
      const lead = this.leads.find((l) => l.id === m.lead_id);
      if (!lead) continue;
      const r = await this.http('/evolution/message/sendText/e2e', { metodo: 'POST', cuerpo: { number: lead.telefono, text: m.texto ?? m.tipo }, headers: { apikey: 'e2e' } });
      m.intentos++;
      if (r && r.estado < 300) m.estado = 'enviado';
      else if (m.intentos >= 3) m.estado = 'dead_letter';
    }
  }

  private async correrTrabajos(): Promise<void> {
    for (const t of this.trabajos.filter((x) => x.estado === 'pendiente' && x.visible_desde <= this.ms)) {
      t.intentos++;
      const ok = t.cola === 'zoho' ? await this.trabajoZoho(t) : await this.trabajoCapi(t);
      if (ok) t.estado = 'hecho';
      else if (t.intentos >= (t.cola === 'zoho' ? MAX_INTENTOS_ZOHO : MAX_INTENTOS_CAPI)) t.estado = 'dead_letter';
      else t.visible_desde = this.ms + backoffMs(t.intentos);
    }
  }

  private async trabajoZoho(t: TrabajoSim): Promise<boolean> {
    const c = this.cita(String(t.datos.cita_id));
    if (!c) return true;
    const uid = this.reglas(c.vacante_id).reglas.zoho_calendar_uid;
    if (!uid) return true; // Z7: se confirma igual; alerta de configuración incompleta
    const h = { authorization: 'Zoho-oauthtoken e2e' };
    if (t.accion === 'borrar') {
      if (!c.zoho_event_uid) return true;
      const r = await this.http(`/zoho/api/v1/calendars/${uid}/events/${c.zoho_event_uid}`, { metodo: 'DELETE', headers: h });
      if (!r || r.estado >= 300) return (t.ultimo_error = `zoho ${r?.estado ?? 'red'}`), false;
      c.zoho_event_uid = null;
      return true;
    }
    if (c.zoho_event_uid) return true; // Z2: idempotente
    const lead = this.leads.find((l) => l.id === c.lead_id)!;
    const ev = construirEventoMinimo({ citaId: c.id, folio: lead.folio, nombrePila: lead.nombre_pila, inicio: c.inicio, fin: c.fin }, { panelUrl: URL_WEB, zonaHoraria: this.reglas(c.vacante_id).reglas.agenda.zona_horaria });
    if (!ev.ok) return true;
    const r = await this.http(`/zoho/api/v1/calendars/${uid}/events`, { metodo: 'POST', headers: h, cuerpo: { eventdata: { title: ev.value.titulo, description: ev.value.descripcion, dateandtime: { start: ev.value.inicio, end: ev.value.fin, timezone: ev.value.zonaHoraria }, uid: ev.value.uidPropio, attendees: [] } } });
    if (!r || r.estado >= 300) return (t.ultimo_error = `zoho ${r?.estado ?? 'red'}`), false;
    c.zoho_event_uid = (r.cuerpo as { events?: Array<{ uid?: string }> }).events?.[0]?.uid ?? 'zev';
    return true;
  }

  private async trabajoCapi(t: TrabajoSim): Promise<boolean> {
    const lead = this.leads.find((l) => l.id === t.datos.lead_id);
    if (!lead) return true;
    const v = this.vacantePor(String(t.datos.vacante_id))!;
    const evento = await construirEventoMeta({
      eventId: String(t.datos.event_id), nombreMeta: t.accion, actionSource: t.datos.action_source as 'website' | 'system_generated', ocurridoEn: this.ahora(),
      urlOrigen: `${URL_WEB}/vacantes/${v.slug}/`, customData: { vacancy_id: v.id, client_id: v.cliente_id, content_category: 'telecomunicaciones' },
      contacto: { telefono: lead.telefono, email: lead.email, nombrePila: lead.nombre_pila },
      visitante: { visitorId: lead.atribucion.visitor_id ?? null, ip: null, userAgent: null, fbc: lead.atribucion.fbc ?? null, fbp: lead.atribucion.fbp ?? null },
    });
    const r = await this.http(`/meta/v21.0/${PIXEL_ID_E2E}/events`, { metodo: 'POST', cuerpo: { data: [evento], access_token: 'e2e' } });
    return !!r && r.estado < 300;
  }
}

export function crearBackend(proveedores: MocksProveedores): BackendSimulado {
  return new BackendSimulado(proveedores);
}
