/**
 * Servidor HTTP de mocks para los proveedores que llaman las EDGE FUNCTIONS (no el navegador):
 * Zoho Calendar/OAuth, Meta CAPI (Graph), Stape, Evolution API y NBX. Registra cada llamada y
 * permite simular caídas (E2E-07). La ola 2 apunta las funciones locales aquí vía entorno:
 *   EVOLUTION_URL=<url>/evolution · STAPE_URL=<url>/stape · NBX_API_URL=<url>/nbx
 *   Zoho: el adaptador necesita un override de dominio (ver docs/bitacora/plataforma.md).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Proveedor = 'zoho' | 'meta' | 'stape' | 'evolution' | 'nbx';

export interface Llamada {
  proveedor: Proveedor;
  metodo: string;
  ruta: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  cuerpo: unknown;
  en: string;
}

export interface Respuesta {
  estado: number;
  cuerpo?: unknown;
}

type Manejador = (l: Llamada) => Respuesta;

export interface MocksProveedores {
  url: string;
  /** Variables de entorno para las edge functions locales. */
  entorno: Record<string, string>;
  llamadas(proveedor?: Proveedor): Llamada[];
  /** Sobrescribe la respuesta de un proveedor (p. ej. Zoho caído → 503). */
  responder(proveedor: Proveedor, manejador: Manejador): void;
  /** Las próximas `veces` llamadas al proveedor responden `estado` (por defecto 503). */
  fallar(proveedor: Proveedor, veces?: number, estado?: number): void;
  reiniciar(): void;
  cerrar(): Promise<void>;
}

let secuencia = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(++secuencia).toString(36)}`;

/** Respuestas por defecto con la forma de cada API real (fixtures de contrato de cada dominio). */
export const RESPUESTAS_DEFECTO: Record<Proveedor, Manejador> = {
  zoho: (l) => {
    if (l.ruta.endsWith('/oauth/v2/token')) return { estado: 200, cuerpo: { access_token: uid('zat'), expires_in: 3600, token_type: 'Bearer', api_domain: 'https://www.zohoapis.com' } };
    if (l.metodo === 'DELETE') return { estado: 200, cuerpo: { events: [{ uid: l.ruta.split('/').pop() }] } };
    if (l.metodo === 'POST' || l.metodo === 'PUT') return { estado: 200, cuerpo: { events: [{ uid: uid('zev'), etag: String(Date.now()) }] } };
    return { estado: 200, cuerpo: { events: [] } };
  },
  meta: (l) => ({ estado: 200, cuerpo: { events_received: Array.isArray((l.cuerpo as { data?: unknown[] })?.data) ? (l.cuerpo as { data: unknown[] }).data.length : 1, fbtrace_id: uid('fb') } }),
  stape: () => ({ estado: 200, cuerpo: { ok: true } }),
  evolution: (l) => {
    if (l.ruta.includes('/chat/whatsappNumbers/')) {
      const numeros = ((l.cuerpo as { numbers?: string[] })?.numbers ?? []) as string[];
      return { estado: 200, cuerpo: numeros.map((n) => ({ exists: !n.endsWith('0000'), jid: `${n}@s.whatsapp.net`, number: n })) };
    }
    return { estado: 201, cuerpo: { key: { id: uid('wamid'), remoteJid: 'x@s.whatsapp.net', fromMe: true }, status: 'PENDING' } };
  },
  nbx: () => ({ estado: 200, cuerpo: { id: uid('sms'), status: 'queued' } }),
};

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  for await (const p of req) partes.push(p as Buffer);
  const texto = Buffer.concat(partes).toString('utf8');
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export async function iniciarMocksProveedores(puerto = 0): Promise<MocksProveedores> {
  const registro: Llamada[] = [];
  const manejadores = new Map<Proveedor, Manejador>();
  const fallas = new Map<Proveedor, { veces: number; estado: number }>();

  const srv: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const proveedor = url.pathname.split('/')[1] as Proveedor;
    if (!(proveedor in RESPUESTAS_DEFECTO)) {
      res.writeHead(404).end();
      return;
    }
    const llamada: Llamada = {
      proveedor,
      metodo: req.method ?? 'GET',
      ruta: url.pathname.slice(proveedor.length + 1) || '/',
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      cuerpo: await leerCuerpo(req),
      en: new Date().toISOString(),
    };
    registro.push(llamada);
    const falla = fallas.get(proveedor);
    let r: Respuesta;
    if (falla && falla.veces > 0) {
      falla.veces--;
      r = { estado: falla.estado, cuerpo: { error: 'mock: proveedor caído' } };
    } else {
      r = (manejadores.get(proveedor) ?? RESPUESTAS_DEFECTO[proveedor])(llamada);
    }
    res.writeHead(r.estado, { 'content-type': 'application/json' }).end(r.cuerpo === undefined ? '' : JSON.stringify(r.cuerpo));
  });

  await new Promise<void>((ok) => srv.listen(puerto, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  return {
    url,
    entorno: {
      EVOLUTION_URL: `${url}/evolution`,
      STAPE_URL: `${url}/stape`,
      NBX_API_URL: `${url}/nbx`,
      META_GRAPH_URL: `${url}/meta`,
      ZOHO_BASE_URL: `${url}/zoho`,
    },
    llamadas: (p) => (p ? registro.filter((l) => l.proveedor === p) : [...registro]),
    responder: (p, m) => void manejadores.set(p, m),
    fallar: (p, veces = 1, estado = 503) => void fallas.set(p, { veces, estado }),
    reiniciar: () => {
      registro.length = 0;
      manejadores.clear();
      fallas.clear();
    },
    cerrar: () => new Promise<void>((ok) => srv.close(() => ok())),
  };
}
