/** Adaptador de ReglasVacantePort sobre config.reglas_vigentes (API pública de config). */
import type { SqlClient } from '@shared/sql.ts';
import type { Logger } from '@shared/logger.ts';
import { ReglasMensajesSchema } from '../domain/plantillas.ts';
import type { ReglasVacantePort } from '../application/puertos.ts';

export function crearReglasVacanteSql(sql: SqlClient, logger?: Logger): ReglasVacantePort {
  return {
    async obtener(vacanteId) {
      const { rows } = await sql.query<{ version: number; reglas: Record<string, unknown> | null }>(`select version, reglas from config.reglas_vigentes($1)`, [vacanteId]);
      const fila = rows[0];
      if (!fila?.reglas) return { reglas: ReglasMensajesSchema.parse({}), origen: 'defecto' };
      const bloque = (fila.reglas.mensajes ?? {}) as Record<string, unknown>;
      // CONTRATOS §vacantes: ventana_contacto puede vivir al nivel raíz de las reglas de la vacante.
      const candidato = bloque.ventana_contacto === undefined && fila.reglas.ventana_contacto !== undefined ? { ...bloque, ventana_contacto: fila.reglas.ventana_contacto } : bloque;
      const r = ReglasMensajesSchema.safeParse(candidato);
      if (!r.success) {
        logger?.warn('reglas de mensajes inválidas; se usan las por defecto', { vacante_id: vacanteId, version: fila.version });
        return { reglas: ReglasMensajesSchema.parse({}), origen: 'defecto' };
      }
      return { reglas: r.data, origen: `vacante:v${fila.version}` };
    },
  };
}
