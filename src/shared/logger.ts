/**
 * Logger estructurado con redacción de PII (R8, NFR-SEG-04, NFR-OBS-01).
 * Redacta teléfonos, correos, IPs, códigos OTP y claves sensibles conocidas.
 */
export type Nivel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

const CLAVES_SENSIBLES = /^(telefono|phone|ph|tel|whatsapp|email|correo|em|nombre|name|fn|ln|apellido|ip|ip_address|client_ip_address|codigo|code|otp|token|password|secret|authorization|respuestas|direccion)$/i;
const PATRONES: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '***'],
  [/(?:\+?\d[\s-]?){10,13}/g, '***'],
  [/\b\d{6}\b/g, '***'],
];

export function redactar(valor: unknown, clave?: string, profundidad = 0): unknown {
  if (clave && CLAVES_SENSIBLES.test(clave)) return valor == null ? valor : '***';
  if (typeof valor === 'string') return PATRONES.reduce((s, [re, r]) => s.replace(re, r), valor);
  if (profundidad > 6 || valor == null || typeof valor !== 'object') return valor;
  if (Array.isArray(valor)) return valor.map((v) => redactar(v, undefined, profundidad + 1));
  return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, redactar(v, k, profundidad + 1)]));
}

export type Sink = (linea: string) => void;

export function crearLogger(base: Record<string, unknown> = {}, sink: Sink = (l) => globalThis.console.log(l)): Logger {
  const emit = (nivel: Nivel, msg: string, ctx?: Record<string, unknown>) =>
    sink(JSON.stringify({ ts: new Date().toISOString(), nivel, msg: redactar(msg), ...(redactar({ ...base, ...ctx }) as object) }));
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (c) => crearLogger({ ...base, ...c }, sink),
  };
}
