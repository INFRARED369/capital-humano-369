/**
 * Establecer contraseña desde el enlace de Supabase Auth (invitación o recuperación) — lógica pura.
 * El enlace llega como `/panel/acceso/#access_token=…&refresh_token=…&type=invite|recovery` (flujo implícito)
 * o con error: `#error=access_denied&error_code=otp_expired&error_description=…`.
 * Reglas de contraseña = supabase/config.toml: mínimo 12, minúsculas, mayúsculas y dígitos.
 */
export type TipoEnlace = 'invite' | 'recovery' | 'otro';
export interface EnlaceAuth { tipo: TipoEnlace | null; tieneToken: boolean; error: { codigo: string; vencido: boolean } | null }

export const MIN_CONTRASENA = 12;

export function leerEnlaceAuth(hash: string): EnlaceAuth {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const tipo = p.get('type');
  const codigo = p.get('error_code') ?? p.get('error');
  return {
    tipo: tipo === 'invite' || tipo === 'recovery' ? tipo : tipo ? 'otro' : null,
    tieneToken: !!p.get('access_token'),
    error: codigo ? { codigo: codigo.slice(0, 40), vencido: /expired/i.test(codigo) || /expired/i.test(p.get('error_description') ?? '') } : null,
  };
}

/** Problemas de la contraseña nueva (vacío = válida). Mensajes en texto llano para `aria-describedby`. */
export function problemasContrasena(nueva: string, confirmacion: string): string[] {
  const p: string[] = [];
  if (nueva.length < MIN_CONTRASENA) p.push(`Usa al menos ${MIN_CONTRASENA} caracteres.`);
  if (!/[a-z]/.test(nueva)) p.push('Incluye al menos una letra minúscula.');
  if (!/[A-Z]/.test(nueva)) p.push('Incluye al menos una letra mayúscula.');
  if (!/\d/.test(nueva)) p.push('Incluye al menos un número.');
  if (nueva !== confirmacion) p.push('Las contraseñas no coinciden.');
  return p;
}

/** Traduce el error de Supabase Auth al actualizar la contraseña. */
export function mensajeErrorContrasena(codigo: string | undefined): string {
  switch (codigo) {
    case 'weak_password': return 'La contraseña es demasiado débil. Sigue los requisitos indicados.';
    case 'same_password': return 'La contraseña nueva debe ser distinta de la anterior.';
    case 'reauthentication_needed':
    case 'session_not_found':
    case 'bad_jwt': return 'Tu enlace ya no es válido. Pide uno nuevo.';
    default: return 'No se pudo guardar la contraseña. Intenta de nuevo.';
  }
}
