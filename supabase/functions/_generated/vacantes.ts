// GENERADO por scripts/generar-indice-vacantes.mjs — NO editar a mano.
// Alta de una vacante: agregar apps/web/vacantes/<slug>.json y correr `npm run generar:vacantes` (corre solo en prebuild).
// Las reglas operativas (agenda, mensajes, Zoho) se configuran en el panel, no aquí (NFR-ESC-06).
import v0 from '../../../apps/web/vacantes/agente-smart.json' with { type: 'json' };

/** Contenido crudo de cada vacante; validar con ContenidoVacanteSchema antes de usarlo. */
export const CONTENIDOS_VACANTES: readonly unknown[] = [v0];
export const SLUGS_ARCHIVO = ['agente-smart'] as const;
