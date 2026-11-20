/** Adaptador SQL de CitasRepo. Lee solo su schema, `shared.vacantes` (kernel) y `config.reglas_vigentes`. */
import type { EventoDominio } from '@shared/eventos.ts';
import { UUID_RE } from '@shared/ids.ts';
import type { SqlClient } from '@shared/sql.ts';
import type { EstadoCita } from '../domain/estados.ts';
import type { FilaReglas } from '../domain/reglas.ts';
import type { CitaActiva } from '../domain/slots.ts';
import type { CambioEstado, CitaRegistro, CitasRepo, ResultadoRetencion, SolicitudRetencion, VacanteAgenda } from '../application/puertos.ts';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** timestamptz → ISO 'Z' (PGlite y postgres.js devuelven Date; otros drivers, texto). */
export const aIso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const aIsoONulo = (v: unknown): string | null => (v == null ? null : aIso(v));

interface FilaVacante { id: string; cliente_id: string; activa: boolean; agenda_modo: 'sistema' | 'whatsapp' }
interface FilaCita {
  id: string; cliente_id: string; vacante_id: string; lead_id: string | null; inicio: unknown; fin: unknown;
  estado: EstadoCita; reglas_version: number; expira_en: unknown; motivo: string | null; creado_en: unknown;
}

export function crearRepoSql(sql: SqlClient): CitasRepo {
  return {
    async buscarVacante(ref) {
      const porId = UUID_RE.test(ref);
      if (!porId && !SLUG_RE.test(ref)) return null;
      const { rows } = await sql.query<FilaVacante>(
        `select id, cliente_id, activa, agenda_modo from shared.vacantes where ${porId ? 'id = $1::uuid' : 'slug = $1'}`,
        [ref],
      );
      const v = rows[0];
      return v ? ({ id: v.id, clienteId: v.cliente_id, activa: v.activa, agendaModo: v.agenda_modo } satisfies VacanteAgenda) : null;
    },

    async reglasVigentes(vacanteId) {
      const { rows } = await sql.query<FilaReglas>('select version, reglas from config.reglas_vigentes($1::uuid)', [vacanteId]);
      return rows[0] ?? null;
    },

    async expirarRetenciones(ahora, vacanteId) {
      const { rows } = await sql.query<{ n: number }>('select citas.expirar_retenciones($1::timestamptz, $2::uuid) as n', [ahora, vacanteId ?? null]);
      return rows[0]?.n ?? 0;
    },

    async ocupacion(vacanteId, desde, hasta, ahora) {
      const { rows } = await sql.query<{ inicio: unknown; fin: unknown }>(
        `select inicio, fin from citas.citas
         where vacante_id = $1::uuid and inicio >= $2::timestamptz and inicio < $3::timestamptz
           and (estado = 'confirmada' or (estado = 'retenida' and expira_en > $4::timestamptz))`,
        [vacanteId, desde, hasta, ahora],
      );
      return rows.map((r): CitaActiva => ({ inicio: aIso(r.inicio), fin: aIso(r.fin) }));
    },

    async retener(s: SolicitudRetencion): Promise<ResultadoRetencion> {
      const { rows } = await sql.query<{ r: { resultado: string; cita_id?: string; expira_en?: string | null } }>(
        `select citas.retener($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5::date, $6::int, $7::int, $8::boolean, $9::int,
                              $10::timestamptz, $11::timestamptz, $12::text, $13::uuid) as r`,
        [s.vacanteId, s.leadId, s.inicio, s.fin, s.dia, s.capacidad, s.cupo, s.empalmes, s.reglasVersion, s.expiraEn, s.ahora, s.estado, s.citaAnteriorId ?? null],
      );
      const r = rows[0]!.r;
      if (r.resultado === 'OK') return { resultado: 'OK', citaId: r.cita_id!, expiraEn: r.expira_en ?? null };
      return { resultado: r.resultado as Exclude<ResultadoRetencion['resultado'], 'OK'> };
    },

    async obtener(citaId, { bloquear }) {
      const { rows } = await sql.query<FilaCita>(
        `select id, cliente_id, vacante_id, lead_id, inicio, fin, estado, reglas_version, expira_en, motivo, creado_en
         from citas.citas where id = $1::uuid${bloquear ? ' for update' : ''}`,
        [citaId],
      );
      const c = rows[0];
      return c
        ? ({
            id: c.id,
            clienteId: c.cliente_id,
            vacanteId: c.vacante_id,
            leadId: c.lead_id,
            inicio: aIso(c.inicio),
            fin: aIso(c.fin),
            estado: c.estado,
            reglasVersion: c.reglas_version,
            expiraEn: aIsoONulo(c.expira_en),
            motivo: c.motivo,
            creadoEn: aIso(c.creado_en),
          } satisfies CitaRegistro)
        : null;
    },

    async cambiarEstado(citaId, { estado, ahora, motivo }: CambioEstado) {
      await sql.query(
        `update citas.citas set
           estado = $2::text,
           motivo = coalesce($3::text, motivo),
           expira_en = case when $2::text = 'confirmada' then null else expira_en end,
           confirmada_en = case when $2::text = 'confirmada' then $4::timestamptz else confirmada_en end,
           cancelada_en = case when $2::text = 'cancelada' then $4::timestamptz else cancelada_en end,
           actualizado_en = $4::timestamptz
         where id = $1::uuid`,
        [citaId, estado, motivo ?? null, ahora],
      );
    },

    async extenderRetencion(citaId, expiraEn, ahora) {
      await sql.query(
        `update citas.citas set expira_en = $2::timestamptz, actualizado_en = $3::timestamptz where id = $1::uuid and estado = 'retenida'`,
        [citaId, expiraEn, ahora],
      );
    },

    async publicar(evento: EventoDominio, clienteId: string) {
      await sql.query('select shared.publicar_evento($1, $2::jsonb, $3::uuid)', [evento.tipo, JSON.stringify(evento.payload), clienteId]);
    },
  };
}
