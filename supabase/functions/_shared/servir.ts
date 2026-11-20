/**
 * Envoltura común de las edge functions: CORS/OPTIONS, correlation_id (NFR-OBS-01),
 * logger con redacción (R8) y 500 genérico sin filtrar detalles internos.
 *
 *   Deno.serve(servir((req, ctx) => handler(req, { ...deps, log: ctx.log }), { funcion: 'postular', origenes: env.ALLOWED_ORIGIN }));
 */
import { cors, correlationId, ipCliente, json } from '@shared/http.ts';
import { crearLogger, type Logger, type Sink } from '@shared/logger.ts';

export interface ContextoPeticion {
  correlationId: string;
  log: Logger;
  /** IP del cliente (PII): solo para HMAC de rate limit; nunca registrar en claro. */
  ip: string | null;
}

export type Manejador = (req: Request, ctx: ContextoPeticion) => Promise<Response>;

export interface OpcionesServir {
  funcion: string;
  /** Orígenes permitidos (ALLOWED_ORIGIN). El primero se usa cuando la petición no trae Origin. */
  origenes: readonly string[];
  sink?: Sink;
  ahora?: () => number;
}

export function servir(manejador: Manejador, opts: OpcionesServir): (req: Request) => Promise<Response> {
  if (opts.origenes.length === 0) throw new Error('servir: se requiere al menos un origen permitido');
  const base = crearLogger({ funcion: opts.funcion }, opts.sink);
  const ahora = opts.ahora ?? (() => Date.now());

  return async (req) => {
    const inicio = ahora();
    const cid = correlationId(req);
    const log = base.child({ correlation_id: cid });
    const origen = req.headers.get('origin');
    const permitido = origen !== null && opts.origenes.includes(origen);
    const corsHeaders = cors(permitido ? origen : opts.origenes[0]!);

    let res: Response;
    if (req.method === 'OPTIONS') {
      res = origen !== null && !permitido ? new Response(null, { status: 403 }) : new Response(null, { status: 204, headers: { 'access-control-max-age': '600' } });
    } else {
      try {
        res = await manejador(req, { correlationId: cid, log, ip: ipCliente(req) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        log.error('error_no_controlado', { error: error.name, detalle: error.message.slice(0, 500) });
        res = json({ error: 'error_interno', correlation_id: cid }, 500);
      }
    }

    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    headers.set('x-correlation-id', cid);
    headers.set('x-content-type-options', 'nosniff');
    if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');

    log.info('peticion', { metodo: req.method, ruta: new URL(req.url).pathname, estado: res.status, duracion_ms: ahora() - inicio });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
