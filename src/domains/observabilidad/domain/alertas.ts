/**
 * NFR-OBS-01 · Alertas operativas (dominio puro). Las genera `shared.evaluar_alertas` (SQL) y se notifican
 * por webhook genérico (Slack/Discord) y/o correo. Nunca llevan PII: el detalle pasa por una lista blanca
 * de claves con valores numéricos o códigos cortos.
 */
export const TIPOS_ALERTA = ['cola_atascada', 'dead_letter', 'otp_tasa_fallas', 'zoho', 'retencion_errores', 'retencion_sin_correr'] as const;
export type TipoAlerta = (typeof TIPOS_ALERTA)[number];
export type Severidad = 'aviso' | 'critica';

export interface Alerta {
  id: string;
  tipo: TipoAlerta;
  severidad: Severidad;
  clave: string;
  detalle: Record<string, unknown>;
  creadaEn: string;
}

/** Claves que puede llevar el detalle (las que arma shared.evaluar_alertas). */
const CLAVES_DETALLE = new Set([
  'cola', 'atascados', 'minutos', 'nuevas', 'hasta_id', 'emitidos', 'bloqueados', 'envios_fallidos', 'tasa', 'umbral',
  'zoho_tipo', 'errores', 'ejecutado_en', 'horas', 'ultima',
]);
const RE_CODIGO = /^[\w.:+-]{1,60}$/;
const MAX_NUMERO = 1e10;

const codigo = (v: unknown): v is string => typeof v === 'string' && RE_CODIGO.test(v);

export function sanearDetalle(detalle: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detalle)) {
    if (!CLAVES_DETALLE.has(k)) continue;
    if (v === null) out[k] = null;
    else if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_NUMERO) out[k] = v;
    else if (codigo(v)) out[k] = v;
    else if (Array.isArray(v) && v.length <= 20 && v.every(codigo)) out[k] = [...v];
  }
  return out;
}

const PESO: Record<Severidad, number> = { critica: 0, aviso: 1 };

function linea(a: Alerta): string {
  const det = Object.entries(sanearDetalle(a.detalle)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`).join(' ');
  return `[${a.severidad.toUpperCase()}] ${a.tipo}${det ? ` · ${det}` : ''}`;
}

export function formatearAlertas(alertas: readonly Alerta[], opts: { entorno?: string } = {}): { asunto: string; texto: string } {
  const criticas = alertas.filter((a) => a.severidad === 'critica').length;
  const asunto = `[369${opts.entorno ? ` · ${opts.entorno}` : ''}] ${alertas.length} alerta(s)${criticas ? `, ${criticas} crítica(s)` : ''}`;
  const orden = [...alertas].sort((x, y) => PESO[x.severidad] - PESO[y.severidad] || Number(x.id) - Number(y.id));
  return { asunto, texto: [asunto, ...orden.map(linea), 'Detalle: tabla shared.alertas y docs/runbook.md §8.'].join('\n') };
}

const MAX_TEXTO = 2000; // límite de `content` en Discord

/** Cuerpo para webhooks entrantes: Slack usa `text`, Discord `content`; `alertas` para integraciones propias. */
export function payloadWebhook(alertas: readonly Alerta[], opts: { entorno?: string } = {}) {
  const { texto } = formatearAlertas(alertas, opts);
  const corto = texto.length > MAX_TEXTO ? `${texto.slice(0, MAX_TEXTO - 2)}\n…` : texto;
  return {
    text: corto,
    content: corto,
    alertas: alertas.map((a) => ({ tipo: a.tipo, severidad: a.severidad, clave: a.clave, creada_en: a.creadaEn, detalle: sanearDetalle(a.detalle) })),
  };
}
