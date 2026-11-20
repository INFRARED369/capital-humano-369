/** Adaptador SQL del dominio privacidad: solo funciones del schema privacidad (regla 1 de CONTRATOS). */
import { err, ok } from '@shared/result.ts';
import type { SqlClient } from '@shared/sql.ts';
import type { CanalArco, EstadoArco, TipoArco } from '../../domain/arco.ts';
import type { Conteos } from '../../domain/registro.ts';
import type { ErrorSolicitud, PrivacidadRepo, ResumenRetencion, SolicitudArco } from '../../application/puertos.ts';

type FilaSolicitud = {
  id: string; tipo: TipoArco; canal: CanalArco; estado: EstadoArco; recibida_en: unknown; limite_respuesta: unknown; limite_ejecucion: unknown;
  cerrada_en: unknown; leads: number; resultado: Conteos | null;
};
const iso = (v: unknown): string => new Date(v as string).toISOString();
const fecha = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const aVista = (r: FilaSolicitud): SolicitudArco => ({
  id: r.id, tipo: r.tipo, canal: r.canal, estado: r.estado, recibidaEn: iso(r.recibida_en), limiteRespuesta: fecha(r.limite_respuesta),
  limiteEjecucion: fecha(r.limite_ejecucion), cerradaEn: r.cerrada_en == null ? null : iso(r.cerrada_en), leads: Number(r.leads), resultado: r.resultado,
});
// Nunca se seleccionan telefono_hmac ni los ids de lead: solo su número.
const COLS = `id, tipo, canal, estado, recibida_en, (limite_respuesta)::text as limite_respuesta, (limite_ejecucion)::text as limite_ejecucion,
  cerrada_en, cardinality(leads) as leads, resultado`;

const ERRORES: Record<string, ErrorSolicitud> = { NO_ENCONTRADA: 'NO_ENCONTRADA', TRANSICION_INVALIDA: 'TRANSICION_INVALIDA', TIPO_NO_EJECUTABLE: 'TIPO_NO_EJECUTABLE' };
function errorDe(e: unknown): ErrorSolicitud {
  const m = (e as Error).message ?? '';
  const k = Object.keys(ERRORES).find((x) => m.includes(x));
  if (!k) throw e;
  return ERRORES[k]!;
}

export function crearRepoPrivacidadSql(sql: SqlClient): PrivacidadRepo {
  return {
    async retencionDiaria(ahora, maxLotes = 20) {
      const { rows } = await sql.query<{ r: Record<string, unknown> }>('select privacidad.retencion_diaria($1::timestamptz, $2::int) as r', [ahora.toISOString(), maxLotes]);
      const r = rows[0]!.r;
      if (r.omitida) return { registroId: null, omitida: true, dominios: [], faltantes: [], errores: {}, lotes: {}, conteos: {}, total: 0 };
      return {
        registroId: Number(r.registro_id), omitida: false, dominios: r.dominios as string[], faltantes: r.faltantes as string[],
        errores: r.errores as Record<string, string>, lotes: r.lotes as Record<string, number>, conteos: r.conteos as Conteos, total: Number(r.total),
      } satisfies ResumenRetencion;
    },

    async registrarSolicitud(s) {
      const { rows } = await sql.query<{ id: string }>(
        'select privacidad.arco_registrar($1, $2, $3, $4::uuid[], $5::timestamptz, $6::date, $7::date, $8::uuid) as id',
        [s.tipo, s.canal, s.telefonoHmac, s.leads, s.recibidaEn.toISOString(), s.limiteRespuesta, s.limiteEjecucion, s.creadoPor],
      );
      return rows[0]!.id;
    },

    async obtenerSolicitud(id) {
      const { rows } = await sql.query<FilaSolicitud>(`select ${COLS} from privacidad.solicitudes_arco where id = $1`, [id]);
      return rows[0] ? aVista(rows[0]) : null;
    },

    async listarSolicitudes(f) {
      const { rows } = await sql.query<FilaSolicitud>(
        `select ${COLS} from privacidad.solicitudes_arco where ($1::text is null or estado = $1) order by limite_respuesta, recibida_en limit $2`,
        [f.estado ?? null, f.limite],
      );
      return rows.map(aVista);
    },

    async ejecutarSolicitud(id, ahora) {
      try {
        const { rows } = await sql.query<{ r: { conteos: Conteos; faltantes: string[] } }>('select privacidad.arco_ejecutar($1, $2::timestamptz) as r', [id, ahora.toISOString()]);
        return ok(rows[0]!.r);
      } catch (e) {
        return err(errorDe(e));
      }
    },

    async responderSolicitud(id, estado, motivo, ahora) {
      try {
        await sql.query('select privacidad.arco_responder($1, $2, $3, $4::timestamptz)', [id, estado, motivo, ahora.toISOString()]);
        return ok(undefined);
      } catch (e) {
        return err(errorDe(e));
      }
    },
  };
}
