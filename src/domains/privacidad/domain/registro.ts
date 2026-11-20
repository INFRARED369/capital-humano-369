/**
 * Registro de supresiones (PRV-03): solo conteos, fechas y reglas aplicadas; nunca los datos borrados.
 * Las mismas restricciones viven como CHECK en `privacidad.registro_supresiones` (defensa en profundidad).
 */
import { err, ok, type Result } from '@shared/result.ts';

/** Orden de la política: captación (publica LeadSuprimido), citas (+zoho), comunicación, tracking, dashboard y al final el kernel (outbox). Paridad con privacidad.dominios() (SQL). */
export const DOMINIOS_RETENCION = ['captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'shared'] as const;
export type DominioRetencion = (typeof DOMINIOS_RETENCION)[number];

export const TIPOS_REGISTRO = ['retencion', 'arco', 'supresion'] as const;
export type TipoRegistro = (typeof TIPOS_REGISTRO)[number];

export type Conteos = { [llave: string]: number | Conteos };

const LLAVE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REGLA = /^[a-z][a-z0-9_.]{0,79}$/;
const PROFUNDIDAD_MAX = 6;

export function esSoloConteos(v: unknown, profundidad = 0): v is Conteos {
  if (profundidad >= PROFUNDIDAD_MAX || v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([k, x]) =>
    LLAVE.test(k) && (typeof x === 'number' ? Number.isInteger(x) && x >= 0 : esSoloConteos(x, profundidad + 1)),
  );
}

/** Suma b sobre a (sin mutar). Los valores que no son números ni objetos se ignoran. */
export function sumarConteos(a: Conteos, b: Record<string, unknown>): Conteos {
  const r: Conteos = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') r[k] = (typeof r[k] === 'number' ? (r[k] as number) : 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) r[k] = sumarConteos(typeof r[k] === 'object' ? (r[k] as Conteos) : {}, v as Record<string, unknown>);
  }
  return r;
}

export function totalConteos(c: Conteos): number {
  return Object.values(c).reduce<number>((s, v) => s + (typeof v === 'number' ? v : totalConteos(v)), 0);
}

export function faltantes(existentes: readonly string[]): DominioRetencion[] {
  return DOMINIOS_RETENCION.filter((d) => !existentes.includes(d));
}

export interface RegistroSupresion {
  tipo: TipoRegistro;
  reglas: string[];
  conteos: Conteos;
  faltantes: string[];
}

export function validarRegistro(r: RegistroSupresion): Result<RegistroSupresion, 'REGISTRO_CON_DATOS'> {
  const valido = (TIPOS_REGISTRO as readonly string[]).includes(r.tipo)
    && r.reglas.every((x) => REGLA.test(x))
    && r.faltantes.every((x) => REGLA.test(x))
    && esSoloConteos(r.conteos);
  return valido ? ok(r) : err('REGISTRO_CON_DATOS');
}
