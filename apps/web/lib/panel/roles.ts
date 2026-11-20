/**
 * Roles del panel (DSH-06). Solo decide QUÉ MOSTRAR: la autorización real la hacen el RLS y las funciones
 * security definer (S1, S3). admin: todo · reclutador: sus vacantes · cliente: lectura de la suya.
 */
export type Rol = 'admin' | 'reclutador' | 'cliente';

export interface Perfil {
  userId: string;
  email: string;
  roles: Rol[];
  vacantesAsignadas: string[];
  etiqueta: string;
}

export function resumirPerfil(userId: string, email: string, filasRoles: ReadonlyArray<{ rol: string }>, asignaciones: ReadonlyArray<{ vacante_id: string }>): Perfil {
  const roles = (['admin', 'reclutador', 'cliente'] as const).filter((r) => filasRoles.some((f) => f.rol === r));
  const etiqueta = roles.includes('admin') ? 'Administración' : roles.includes('reclutador') ? 'Reclutador' : roles.includes('cliente') ? 'Cliente (solo lectura)' : 'Sin rol asignado';
  return { userId, email, roles, vacantesAsignadas: asignaciones.map((a) => a.vacante_id), etiqueta };
}

export const esAdmin = (p: Perfil) => p.roles.includes('admin');
export const puedeOperar = (p: Perfil, vacanteId: string) => esAdmin(p) || (p.roles.includes('reclutador') && p.vacantesAsignadas.includes(vacanteId));
export const puedeEditarReglas = puedeOperar;
export const puedeEditarCalendario = esAdmin;
