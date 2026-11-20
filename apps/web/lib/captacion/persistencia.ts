/**
 * Avance del candidato en el navegador: si recarga la página vuelve al mismo paso con los mismos datos.
 * Vive en sessionStorage (se borra al cerrar la pestaña; nunca sale del dispositivo) y vence a las 2 horas.
 * No se guarda el token anti-bot ni el código OTP. Cualquier fallo de almacenamiento se ignora: el flujo
 * funciona igual sin él (modo privado, almacenamiento bloqueado, cuota llena).
 */
import { CANALES_OTP, estadoInicial, type CanalOtp, type EstadoFlujo, type Paso } from './flujo';
import type { ValoresFormulario } from './formulario';

export const VERSION_AVANCE = 1;
export const VIGENCIA_AVANCE_MS = 2 * 60 * 60 * 1000;
const PASOS: readonly Paso[] = ['formulario', 'horario', 'whatsapp', 'otp', 'pase', 'fallback'];

export interface Avance {
  estado: EstadoFlujo;
  valores: ValoresFormulario;
  consentido: boolean;
  canal: CanalOtp;
  dia: string | null;
  slot: string | null;
}

interface Guardado extends Avance {
  v: number;
  guardadoEn: number;
}

export const llaveAvance = (slug: string) => `369:postulacion:${slug}`;

type Almacen = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function almacen(): Almacen | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const texto = (v: unknown): v is string => typeof v === 'string';
const textoONull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Valida lo leído: si algo no cuadra (otra versión, datos alterados, vencido) se descarta completo. */
export function interpretarAvance(crudo: string | null, ahora: number): Avance | null {
  if (!crudo) return null;
  let g: Partial<Guardado>;
  try {
    g = JSON.parse(crudo) as Partial<Guardado>;
  } catch {
    return null;
  }
  if (g?.v !== VERSION_AVANCE || typeof g.guardadoEn !== 'number' || ahora - g.guardadoEn > VIGENCIA_AVANCE_MS || ahora < g.guardadoEn - 60_000) return null;
  const e = g.estado as Partial<EstadoFlujo> | undefined;
  const val = g.valores as Partial<ValoresFormulario> | undefined;
  if (!e || !PASOS.includes(e.paso as Paso) || !val || !texto(val.nombre) || !texto(val.telefono) || !texto(val.email)) return null;
  if (typeof val.respuestas !== 'object' || val.respuestas === null || !Object.values(val.respuestas).every(texto)) return null;
  if (!CANALES_OTP.includes(g.canal as CanalOtp) || !CANALES_OTP.includes(e.canal as CanalOtp)) return null;
  if (![e.leadId, e.folio, e.expiraEn, e.citaInicio, e.aviso, g.dia, g.slot].every(textoONull) || typeof e.reenviosRestantes !== 'number') return null;
  // Los pasos que dependen del servidor necesitan su lead; sin él se vuelve a los datos.
  const paso: Paso = (e.paso === 'otp' || e.paso === 'pase') && !e.leadId ? 'formulario' : (e.paso as Paso);
  return {
    estado: { ...estadoInicial, ...(e as EstadoFlujo), paso },
    valores: { nombre: val.nombre, telefono: val.telefono, email: val.email, respuestas: { ...val.respuestas } as Record<string, string> },
    consentido: g.consentido === true,
    canal: g.canal as CanalOtp,
    dia: g.dia ?? null,
    slot: g.slot ?? null,
  };
}

export function leerAvance(slug: string, ahora = Date.now(), a: Almacen | null = almacen()): Avance | null {
  if (!a) return null;
  try {
    const r = interpretarAvance(a.getItem(llaveAvance(slug)), ahora);
    if (!r) a.removeItem(llaveAvance(slug));
    return r;
  } catch {
    return null;
  }
}

export function guardarAvance(slug: string, avance: Avance, ahora = Date.now(), a: Almacen | null = almacen()): void {
  if (!a) return;
  try {
    const g: Guardado = { v: VERSION_AVANCE, guardadoEn: ahora, ...avance };
    a.setItem(llaveAvance(slug), JSON.stringify(g));
  } catch {
    /* sin almacenamiento: el flujo sigue sin persistir */
  }
}

export function borrarAvance(slug: string, a: Almacen | null = almacen()): void {
  try {
    a?.removeItem(llaveAvance(slug));
  } catch {
    /* ignorar */
  }
}

/** ¿Hay algo que valga la pena guardar? (un formulario vacío en el primer paso no se guarda). */
export function hayAvance(a: Avance): boolean {
  const v = a.valores;
  return a.estado.paso !== 'formulario' || !!(v.nombre.trim() || v.telefono.trim() || v.email.trim() || Object.values(v.respuestas).some(Boolean) || a.consentido);
}
