/**
 * SDK de tracking del navegador (dueño: dominio tracking).
 * - TRK-01: nada de terceros ni cookies de marketing hasta aceptar; la decisión se guarda con la versión del aviso.
 * - TRK-02: Clarity solo tras aceptar, con el documento completo enmascarado.
 * - D10/TRK-08: un solo Pixel; cada evento lleva custom_data { vacancy_id, client_id, content_category }.
 * - TRK-05: event_id UUID v7 compartido entre Pixel y servidor.
 * - T8: Schedule (CitaConfirmada) jamás sale del navegador; Lead solo al Pixel (el servidor lo manda por CAPI).
 * - Sin consentimiento: solo conteo técnico (sin visitor_id, sin cookies, sin click ids).
 * Todas las dependencias del navegador se inyectan para probarlo en Node.
 */
import { uuidv7 } from '../../../../src/shared/ids';

export type NombreEventoFunnel =
  | 'PageView' | 'ConsentAccepted' | 'VideoPlay' | 'VideoProgress50' | 'VideoComplete' | 'ClickCTA'
  | 'SectionView' | 'FormStarted' | 'FormSubmitted' | 'LeadCreado' | 'WhatsAppVerificado' | 'CitaConfirmada';

export interface ContextoVacante { vacancy_id: string; client_id: string; content_category: string }

export interface Atribucion {
  visitor_id: string | null;
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_content?: string; utm_term?: string;
  fbclid?: string; gclid?: string; fbc?: string; fbp?: string; referrer?: string; landing?: string;
}

export type EstadoConsentimiento = 'aceptado' | 'rechazado' | null;

export interface ConfigTracker { ingestUrl: string; pixelId: string; clarityId: string; versionAviso: string }

type FnGlobal = ((...args: unknown[]) => void) & Record<string, unknown>;

export interface DepsTracker {
  config: ConfigTracker;
  cookies: { leer(nombre: string): string | null; escribir(nombre: string, valor: string, dias: number): void; borrar(nombre: string): void };
  ubicacion(): { pathname: string; hostname: string; searchParams: URLSearchParams };
  referrer(): string;
  enviar(url: string, cuerpo: string): void;
  cargarScript(id: string, src: string): void;
  marcarEnmascarado(): void;
  global: Record<string, unknown>;
  ahora(): Date;
}

export const COOKIES = { consentimiento: '_369_consent', visitante: '_369_vid', atribucion: '_369_attr', fbp: '_fbp', fbc: '_fbc' } as const;
const DIAS_CONSENTIMIENTO = 180;
const DIAS_MARKETING = 90; // = retención de eventos crudos

/** §8 · eventos que el Pixel recibe (mismo mapeo que el dominio; probado). */
export const EVENTO_PIXEL: Partial<Record<NombreEventoFunnel, string>> = {
  PageView: 'PageView',
  VideoPlay: 'ViewContent',
  ClickCTA: 'Contact',
  LeadCreado: 'Lead',
};
/** Eventos que registra el servidor desde el outbox: el navegador no los envía a la ingesta. */
const SOLO_SERVIDOR = new Set<NombreEventoFunnel>(['LeadCreado', 'WhatsAppVerificado', 'CitaConfirmada']);

const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARECE_PII = /@|(?:\d[\s().-]?){7,}/;
const LLAVE_PROP = /^[a-z][a-z0-9_]{0,31}$/;

type Primitivo = string | number | boolean;
interface Pendiente { nombre: NombreEventoFunnel; props: Record<string, Primitivo>; eventId: string }
interface AtribucionGuardada { utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_content?: string; utm_term?: string; fbclid?: string; gclid?: string; landing?: string }

/** Sin PII hacia ingesta/Pixel: solo primitivos cortos con llaves simples y sin correos ni teléfonos. */
export function sanearProps(props: Record<string, unknown>): Record<string, Primitivo> {
  const out: Record<string, Primitivo> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!LLAVE_PROP.test(k) || Object.keys(out).length >= 12) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && !PARECE_PII.test(v)) out[k] = v.slice(0, 200);
  }
  return out;
}

const origenDe = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

export interface Tracker {
  iniciar(): void;
  track(nombre: NombreEventoFunnel, props?: Record<string, unknown>, eventId?: string): string;
  obtenerAtribucion(): Atribucion;
  tieneConsentimiento(): boolean;
  estadoConsentimiento(): EstadoConsentimiento;
  /** true después de iniciar(): antes no se sabe si hay decisión guardada (evita parpadeo del banner). */
  iniciado(): boolean;
  fijarContextoVacante(ctx: ContextoVacante | null): void;
  aceptar(): void;
  rechazar(): void;
  reabrir(): void;
  alOcultarPagina(): void;
  suscribir(fn: () => void): () => void;
}

export function crearTracker(deps: DepsTracker): Tracker {
  const { config, cookies } = deps;
  let estado: EstadoConsentimiento = null;
  let iniciado = false;
  let tercerosCargados = false;
  let contexto: ContextoVacante | null = null;
  let pendientes: Pendiente[] = [];
  const oyentes = new Set<() => void>();
  const notificar = () => oyentes.forEach((fn) => fn());

  const leerConsentimiento = (): EstadoConsentimiento => {
    const [version, decision] = (cookies.leer(COOKIES.consentimiento) ?? '').split('|');
    if (version !== config.versionAviso) return null;
    return decision === 'a' ? 'aceptado' : decision === 'r' ? 'rechazado' : null;
  };

  const parametrosUrl = (): AtribucionGuardada => {
    const p = deps.ubicacion().searchParams;
    const a: AtribucionGuardada = {};
    for (const k of [...UTM, 'fbclid', 'gclid'] as const) {
      const v = p.get(k)?.trim();
      if (v) a[k] = v.slice(0, k === 'fbclid' ? 500 : 150);
    }
    return a;
  };

  const atribucionGuardada = (): AtribucionGuardada => {
    try {
      const v = cookies.leer(COOKIES.atribucion);
      return v ? (JSON.parse(v) as AtribucionGuardada) : {};
    } catch {
      return {};
    }
  };

  /** Atribución vigente: la de la URL si trae campaña (último toque no directo); si no, la guardada. */
  const atribucionVigente = (): AtribucionGuardada => {
    const url = parametrosUrl();
    if (Object.keys(url).length) return { ...url, landing: deps.ubicacion().pathname };
    return estado === 'aceptado' ? atribucionGuardada() : {};
  };

  const asegurarIdentificadores = () => {
    const ms = deps.ahora().getTime();
    if (!cookies.leer(COOKIES.visitante)) cookies.escribir(COOKIES.visitante, uuidv7(deps.ahora()), DIAS_MARKETING);
    if (!cookies.leer(COOKIES.fbp)) {
      const aleatorio = String(parseInt(uuidv7(deps.ahora()).slice(-12), 16)).slice(-10).padStart(10, '1');
      cookies.escribir(COOKIES.fbp, `fb.1.${ms}.${aleatorio}`, DIAS_MARKETING);
    }
    const url = parametrosUrl();
    if (url.fbclid) cookies.escribir(COOKIES.fbc, `fb.1.${ms}.${url.fbclid}`, DIAS_MARKETING);
    if (Object.keys(url).length) cookies.escribir(COOKIES.atribucion, JSON.stringify({ ...url, landing: deps.ubicacion().pathname }), DIAS_MARKETING);
  };

  const fn = (nombre: string): FnGlobal | undefined => deps.global[nombre] as FnGlobal | undefined;

  const instalarCola = (nombre: string) => {
    if (fn(nombre)) return;
    const cola: unknown[] = [];
    const stub = ((...args: unknown[]) => void cola.push(args)) as FnGlobal;
    stub.queue = cola;
    stub.q = cola;
    deps.global[nombre] = stub;
  };

  const cargarTerceros = () => {
    if (tercerosCargados) return;
    tercerosCargados = true;
    if (config.clarityId) {
      deps.marcarEnmascarado();
      instalarCola('clarity');
      deps.cargarScript('ch369-clarity', `https://www.clarity.ms/tag/${encodeURIComponent(config.clarityId)}`);
      fn('clarity')?.('consent');
    }
    if (config.pixelId) {
      instalarCola('fbq');
      deps.cargarScript('ch369-pixel', 'https://connect.facebook.net/en_US/fbevents.js');
      const fbq = fn('fbq');
      fbq?.('set', 'autoConfig', false, config.pixelId); // sin recolección automática de formularios/botones
      fbq?.('init', config.pixelId); // sin advanced matching: la PII nunca va al Pixel
    }
  };

  const customData = (): Record<string, string> | undefined => {
    if (!contexto) return undefined;
    const cd: Record<string, string> = {};
    if (/^[\w-]{1,64}$/.test(contexto.vacancy_id)) cd.vacancy_id = contexto.vacancy_id;
    if (UUID.test(contexto.client_id)) cd.client_id = contexto.client_id;
    if (/^[\w -]{1,60}$/.test(contexto.content_category)) cd.content_category = contexto.content_category;
    return Object.keys(cd).length ? cd : undefined;
  };

  const pixel = (nombre: NombreEventoFunnel, eventId: string) => {
    const evento = EVENTO_PIXEL[nombre];
    if (!evento || estado !== 'aceptado' || !config.pixelId) return;
    fn('fbq')?.('track', evento, customData() ?? {}, { eventID: eventId });
  };

  const enviar = (p: Pendiente, conConsentimiento: boolean) => {
    const atr = atribucionVigente();
    const utm = Object.fromEntries(UTM.filter((k) => atr[k]).map((k) => [k, atr[k]!]));
    const cuerpo: Record<string, unknown> = { v: 1, event_id: p.eventId, nombre: p.nombre, consentimiento: conConsentimiento, pagina: deps.ubicacion().pathname.slice(0, 300) };
    const ref = origenDe(deps.referrer());
    if (ref) cuerpo.referrer = ref;
    if (conConsentimiento) {
      cuerpo.visitor_id = cookies.leer(COOKIES.visitante);
      const fbc = cookies.leer(COOKIES.fbc);
      const fbp = cookies.leer(COOKIES.fbp);
      const a = { ...utm, ...(atr.fbclid ? { fbclid: atr.fbclid } : {}), ...(atr.gclid ? { gclid: atr.gclid } : {}), ...(fbc ? { fbc } : {}), ...(fbp ? { fbp } : {}) };
      if (Object.keys(a).length) cuerpo.atribucion = a;
    } else {
      const a = { ...utm, ...(atr.fbclid ? { tiene_fbclid: true } : {}), ...(atr.gclid ? { tiene_gclid: true } : {}) };
      if (Object.keys(a).length) cuerpo.atribucion = a;
    }
    const cd = customData();
    if (cd) cuerpo.custom_data = cd;
    if (Object.keys(p.props).length) cuerpo.props = p.props;
    try {
      deps.enviar(config.ingestUrl, JSON.stringify(cuerpo));
    } catch {
      /* el tracking nunca rompe la página */
    }
    if (conConsentimiento) pixel(p.nombre, p.eventId);
  };

  const vaciarPendientes = (conConsentimiento: boolean) => {
    const cola = pendientes;
    pendientes = [];
    cola.forEach((p) => enviar(p, conConsentimiento));
  };

  const decidir = (decision: 'a' | 'r') => {
    const anterior = estado;
    cookies.escribir(COOKIES.consentimiento, `${config.versionAviso}|${decision}`, DIAS_CONSENTIMIENTO);
    estado = decision === 'a' ? 'aceptado' : 'rechazado';
    if (decision === 'a') {
      asegurarIdentificadores();
      cargarTerceros();
      enviar({ nombre: 'ConsentAccepted', props: {}, eventId: uuidv7(deps.ahora()) }, true);
      vaciarPendientes(true);
    } else {
      for (const c of [COOKIES.visitante, COOKIES.fbp, COOKIES.fbc, COOKIES.atribucion]) cookies.borrar(c);
      if (tercerosCargados || anterior === 'aceptado') {
        fn('fbq')?.('consent', 'revoke');
        fn('clarity')?.('consent', false);
      }
      vaciarPendientes(false);
    }
    notificar();
  };

  return {
    iniciar() {
      if (iniciado) return;
      iniciado = true;
      estado = leerConsentimiento();
      if (estado === 'aceptado') {
        asegurarIdentificadores();
        cargarTerceros();
      }
      notificar();
    },
    track(nombre, props = {}, eventId) {
      const id = eventId && UUID.test(eventId) ? eventId : uuidv7(deps.ahora());
      if (SOLO_SERVIDOR.has(nombre)) {
        pixel(nombre, id); // Lead con el mismo event_id del POST; Schedule no tiene mapeo de Pixel (T8)
        return id;
      }
      const p = { nombre, props: sanearProps(props), eventId: id };
      if (estado === null) pendientes.push(p);
      else enviar(p, estado === 'aceptado');
      return id;
    },
    obtenerAtribucion() {
      if (estado !== 'aceptado') return { visitor_id: null };
      const atr = atribucionVigente();
      const fbc = cookies.leer(COOKIES.fbc);
      const fbp = cookies.leer(COOKIES.fbp);
      const ref = origenDe(deps.referrer());
      return { visitor_id: cookies.leer(COOKIES.visitante), ...atr, ...(fbc ? { fbc } : {}), ...(fbp ? { fbp } : {}), ...(ref ? { referrer: ref } : {}) };
    },
    tieneConsentimiento: () => estado === 'aceptado',
    estadoConsentimiento: () => estado,
    iniciado: () => iniciado,
    fijarContextoVacante(ctx) {
      contexto = ctx;
    },
    aceptar: () => decidir('a'),
    rechazar: () => decidir('r'),
    reabrir() {
      estado = null;
      notificar();
    },
    alOcultarPagina: () => vaciarPendientes(false),
    suscribir(f) {
      oyentes.add(f);
      return () => void oyentes.delete(f);
    },
  };
}

/** Ventana mínima que necesita el SDK (inyectable para pruebas). */
export interface VentanaMinima {
  document: Pick<Document, 'cookie' | 'referrer' | 'head' | 'documentElement' | 'getElementById' | 'createElement'>;
  location: { href: string };
  navigator: { sendBeacon?: (url: string, data?: BodyInit | null) => boolean };
  fetch: typeof fetch;
}

export function depsNavegador(config: ConfigTracker, win: VentanaMinima = window as unknown as VentanaMinima): DepsTracker {
  const doc = win.document;
  const seguro = () => new URL(win.location.href).protocol === 'https:';
  return {
    config,
    cookies: {
      leer(nombre) {
        for (const par of doc.cookie.split(';')) {
          const i = par.indexOf('=');
          if (i > 0 && par.slice(0, i).trim() === nombre) {
            try {
              return decodeURIComponent(par.slice(i + 1).trim());
            } catch {
              return null;
            }
          }
        }
        return null;
      },
      escribir(nombre, valor, dias) {
        doc.cookie = `${nombre}=${encodeURIComponent(valor)}; Max-Age=${dias * 86400}; Path=/; SameSite=Lax${seguro() ? '; Secure' : ''}`;
      },
      borrar(nombre) {
        doc.cookie = `${nombre}=; Max-Age=0; Path=/; SameSite=Lax`;
      },
    },
    ubicacion: () => new URL(win.location.href),
    referrer: () => doc.referrer,
    enviar(url, cuerpo) {
      // text/plain: petición "simple" (sin preflight CORS) compatible con sendBeacon.
      if (win.navigator.sendBeacon?.(url, cuerpo)) return;
      void win.fetch(url, { method: 'POST', body: cuerpo, keepalive: true, credentials: 'omit', mode: 'cors', headers: { 'content-type': 'text/plain;charset=UTF-8' } }).catch(() => undefined);
    },
    cargarScript(id, src) {
      if (doc.getElementById(id)) return;
      const s = doc.createElement('script');
      Object.assign(s, { id, src, async: true });
      doc.head.appendChild(s);
    },
    marcarEnmascarado() {
      doc.documentElement.setAttribute('data-clarity-mask', 'true');
    },
    global: win as unknown as Record<string, unknown>,
    ahora: () => new Date(),
  };
}
