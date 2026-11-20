/** Alta de clientes, vacantes y asignaciones desde el panel, sin código (NFR-ESC-06). */
import { z } from 'zod';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const NuevoClienteSchema = z.strictObject({ nombre: z.string().trim().min(1).max(200) });

export const NuevaVacanteSchema = z.strictObject({
  cliente_id: z.uuid(),
  slug: z.string().max(80).regex(SLUG, 'slug en minúsculas con guiones (p. ej. agente-smart)'),
  codigo: z.string().trim().toUpperCase().min(1).max(40).regex(/^[A-Z0-9-]+$/, 'código con letras, números y guiones'),
  nombre: z.string().trim().min(1).max(200),
  /** Reglas iniciales (se validan con ReglasVacanteSchema en el caso de uso). Sin ellas rige la plantilla. */
  reglas: z.unknown().optional(),
});

export const AsignacionSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  rol: z.enum(['reclutador', 'cliente']),
  vacante_id: z.uuid(),
});

export type NuevoCliente = z.output<typeof NuevoClienteSchema>;
export type NuevaVacante = z.output<typeof NuevaVacanteSchema>;
export type Asignacion = z.output<typeof AsignacionSchema>;

/** Sugerencia de slug a partir del nombre de la vacante. */
export function slugDesdeNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}
