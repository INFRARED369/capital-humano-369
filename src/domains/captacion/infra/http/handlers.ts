/**
 * Handlers puros (Request → Response) de las edge functions de captación (CONTRATOS §6).
 * supabase/functions/{postular,verificar-otp,contacto-b2b}/index.ts solo arman `DepsCaptacion` reales.
 * Las respuestas nunca devuelven datos personales ni el código OTP; los 5xx indican `fallback_whatsapp` (CAP-10).
 */
import { cors, correlationId, ipCliente, json } from '../../../../shared/http.ts';
import type { Result } from '../../../../shared/result.ts';
import { registrarContactoB2B } from '../../application/contacto-b2b.ts';
import { postular } from '../../application/postular.ts';
import type { Contexto, DepsCaptacion } from '../../application/puertos.ts';
import { reenviarOtp, verificarOtp } from '../../application/verificar-otp.ts';

export interface ConfigHttp {
  /** ALLOWED_ORIGIN: uno o varios orígenes; '*' solo en desarrollo. */
  origenPermitido: string | readonly string[];
  maxBytes?: number;
}

const ESTADO: Record<string, number> = {
  FORMATO_INVALIDO: 422, CONSENTIMIENTO_REQUERIDO: 422, WHATSAPP_INVALIDO: 422, OTP_INCORRECTO: 422, CANAL_NO_DISPONIBLE: 422, EMAIL_REQUERIDO: 422,
  ANTIBOT_REQUERIDO: 403, ANTIBOT_INVALIDO: 403,
  VACANTE_NO_ENCONTRADA: 404, NO_ENCONTRADO: 404,
  SLOT_LLENO: 409, CUPO_DIARIO: 409, SLOT_INVALIDO: 409, YA_POSTULADO: 409, YA_VERIFICADO: 409, EVENTO_DUPLICADO: 409, RETENCION_EXPIRADA: 409,
  OTP_VENCIDO: 410,
  OTP_BLOQUEADO: 423,
  LIMITE_TELEFONO: 429, LIMITE_IP: 429,
  ANTIBOT_NO_DISPONIBLE: 503, VERIFICADOR_NO_DISPONIBLE: 503,
};
const ELEGIR_OTRO_HORARIO = new Set(['SLOT_LLENO', 'CUPO_DIARIO', 'SLOT_INVALIDO', 'RETENCION_EXPIRADA']);

const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
function aSnake(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(aSnake);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), aSnake(x)]));
  return v;
}

function respuestaError(error: { codigo: string } & Record<string, unknown>, h: Record<string, string>): Response {
  const { codigo, ...resto } = error;
  const status = ESTADO[codigo] ?? 400;
  const body: Record<string, unknown> = { error: codigo, ...(aSnake(resto) as object) };
  if (ELEGIR_OTRO_HORARIO.has(codigo)) body.elegir_otro_horario = true;
  if (status >= 500) body.fallback_whatsapp = true;
  return json(body, status, status === 429 ? { ...h, 'retry-after': '3600' } : h);
}

type CasoDeUso = (deps: DepsCaptacion, entrada: unknown, ctx: Contexto) => Promise<Result<unknown, { codigo: string }>>;

function crearHandler(deps: DepsCaptacion, cfg: ConfigHttp, elegir: (url: URL) => { caso: CasoDeUso; estadoOk: number }) {
  const origenes = typeof cfg.origenPermitido === 'string' ? [cfg.origenPermitido] : [...cfg.origenPermitido];
  const maxBytes = cfg.maxBytes ?? 16_384;
  return async (req: Request): Promise<Response> => {
    const origen = req.headers.get('origin');
    const permitido = !origen || origenes.includes('*') || origenes.includes(origen);
    const h = cors(origen && permitido ? origen : origenes[0]!);
    if (req.method === 'OPTIONS') return new Response(null, { status: permitido ? 204 : 403, headers: h });
    if (req.method !== 'POST') return json({ error: 'METODO_NO_PERMITIDO' }, 405, { ...h, allow: 'POST, OPTIONS' });
    if (!permitido) return json({ error: 'ORIGEN_NO_PERMITIDO' }, 403, h);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'TIPO_NO_SOPORTADO' }, 415, h);

    const corr = correlationId(req);
    const ctx: Contexto = { ip: ipCliente(req), correlationId: corr };
    const texto = await req.text();
    if (new TextEncoder().encode(texto).length > maxBytes) return json({ error: 'CUERPO_DEMASIADO_GRANDE' }, 413, h);
    let entrada: unknown;
    try {
      entrada = JSON.parse(texto);
    } catch {
      return json({ error: 'JSON_INVALIDO' }, 400, h);
    }

    const { caso, estadoOk } = elegir(new URL(req.url));
    try {
      const r = await caso(deps, entrada, ctx);
      return r.ok ? json(aSnake(r.value), estadoOk, { ...h, 'x-correlation-id': corr }) : respuestaError(r.error as { codigo: string }, { ...h, 'x-correlation-id': corr });
    } catch (e) {
      deps.logger.error('error_inesperado', { correlation_id: corr, error: e instanceof Error ? e.message : String(e) });
      return json({ error: 'ERROR_INTERNO', fallback_whatsapp: true }, 500, { ...h, 'x-correlation-id': corr });
    }
  };
}

export const crearHandlerPostular = (deps: DepsCaptacion, cfg: ConfigHttp) => crearHandler(deps, cfg, () => ({ caso: postular as CasoDeUso, estadoOk: 201 }));

/** POST /verificar-otp → verificar · POST /verificar-otp/reenviar → reenviar. */
export const crearHandlerVerificarOtp = (deps: DepsCaptacion, cfg: ConfigHttp) =>
  crearHandler(deps, cfg, (url) => ({ caso: (url.pathname.replace(/\/+$/, '').endsWith('/reenviar') ? reenviarOtp : verificarOtp) as CasoDeUso, estadoOk: 200 }));

export const crearHandlerContactoB2B = (deps: DepsCaptacion, cfg: ConfigHttp) => crearHandler(deps, cfg, () => ({ caso: registrarContactoB2B as CasoDeUso, estadoOk: 201 }));
