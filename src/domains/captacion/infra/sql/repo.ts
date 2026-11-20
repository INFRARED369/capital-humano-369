/** Adaptador SQL del repositorio de captación (solo su schema + lectura de shared.vacantes y outbox). */
import type { SqlClient } from '../../../../shared/sql.ts';
import type { CaptacionRepo, LeadParaVerificar, OtpGuardado } from '../../application/puertos.ts';
import type { EstadoLead } from '../../domain/lead.ts';
import type { EstadoOtpNombre } from '../../domain/otp.ts';

const iso = (d: Date) => d.toISOString();
const isoONull = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

type FilaLead = { id: string; cliente_id: string; vacante_id: string; folio: string; nombre_pila: string; telefono_hmac: string; estado: EstadoLead; cita_id: string | null; cita_inicio: unknown; tiene_email: boolean };
const COLS_LEAD = 'id, cliente_id, vacante_id, folio, nombre_pila, telefono_hmac, estado, cita_id, cita_inicio, (email is not null) as tiene_email';
const aLead = (r: FilaLead): LeadParaVerificar => ({
  id: r.id, clienteId: r.cliente_id, vacanteId: r.vacante_id, folio: r.folio, nombrePila: r.nombre_pila, telefonoHmac: r.telefono_hmac,
  estado: r.estado, citaId: r.cita_id, citaInicio: isoONull(r.cita_inicio), tieneEmail: !!r.tiene_email,
});

export function crearRepoSql(sql: SqlClient): CaptacionRepo {
  return {
    async buscarVacante(slug) {
      const { rows } = await sql.query<{ id: string; cliente_id: string }>('select id, cliente_id from shared.vacantes where slug = $1 and activa', [slug]);
      return rows[0] ? { id: rows[0].id, clienteId: rows[0].cliente_id } : null;
    },

    async contarEnvios(tipo, f) {
      const { rows } = await sql.query<{ tel: number; ip: number }>(
        `select count(*) filter (where $2::text is not null and telefono_hmac = $2)::int as tel,
                count(*) filter (where $3::text is not null and ip_hmac = $3)::int as ip
         from captacion.envios_limitados where tipo = $1 and creado_en > $4 and (telefono_hmac = $2 or ip_hmac = $3)`,
        [tipo, f.telefonoHmac, f.ipHmac, iso(f.desde)],
      );
      return { porTelefono: rows[0]?.tel ?? 0, porIp: rows[0]?.ip ?? 0 };
    },

    async bloquearTelefono(vacanteId, telefonoHmac) {
      await sql.query('select pg_advisory_xact_lock(hashtextextended($1, 369))', [`captacion:${vacanteId}:${telefonoHmac}`]);
    },

    async buscarLeadDedupe(vacanteId, telefonoHmac, eventId, desde) {
      const { rows } = await sql.query<FilaLead>(
        `select ${COLS_LEAD} from captacion.leads
         where vacante_id = $1 and telefono_hmac = $2 and anonimizado_en is null and (event_id = $3 or postulado_en >= $4)
         order by postulado_en desc limit 1 for update`,
        [vacanteId, telefonoHmac, eventId, iso(desde)],
      );
      return rows[0] ? aLead(rows[0]) : null;
    },

    async existeEventId(eventId) {
      const { rows } = await sql.query('select 1 from captacion.leads where event_id = $1', [eventId]);
      return rows.length > 0;
    },

    async insertarLead(i) {
      const { rows } = await sql.query<{ id: string }>(
        `insert into captacion.leads (cliente_id, vacante_id, folio, nombre, nombre_pila, telefono, telefono_hmac, email, respuestas,
           consentimiento_version, consentido_en, atribucion, visitor_id, event_id, postulado_en, creado_en, actualizado_en)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $11, $11, $11)
         on conflict (folio) do nothing returning id`,
        [i.clienteId, i.vacanteId, i.folio, i.nombre, i.nombrePila, i.telefonoE164, i.telefonoHmac, i.email, JSON.stringify(i.respuestas),
          i.consentimientoVersion, iso(i.ahora), JSON.stringify(i.atribucion), i.visitorId, i.eventId],
      );
      return rows[0]?.id ?? null;
    },

    async reutilizarLead(id, d, ahora) {
      await sql.query(
        `update captacion.leads set nombre = $2, nombre_pila = $3, email = $4, respuestas = $5::jsonb, consentimiento_version = $6,
           consentido_en = $7, atribucion = $8::jsonb, visitor_id = coalesce($9, visitor_id), estado = 'pendiente_otp',
           postulado_en = $7, actualizado_en = $7
         where id = $1`,
        [id, d.nombre, d.nombrePila, d.email, JSON.stringify(d.respuestas), d.consentimientoVersion, iso(ahora), JSON.stringify(d.atribucion), d.visitorId],
      );
    },

    async asignarCita(leadId, citaId, citaInicio, ahora) {
      await sql.query('update captacion.leads set cita_id = $2, cita_inicio = $3, actualizado_en = $4 where id = $1', [leadId, citaId, citaInicio, iso(ahora)]);
    },

    async obtenerLead(leadId) {
      const { rows } = await sql.query<FilaLead>(`select ${COLS_LEAD} from captacion.leads where id = $1 and anonimizado_en is null for update`, [leadId]);
      return rows[0] ? aLead(rows[0]) : null;
    },

    async marcarLead(leadId, estado, ahora) {
      await sql.query(
        `update captacion.leads set estado = $2, actualizado_en = $3, verificado_en = case when $2 = 'verificado' then $3::timestamptz else verificado_en end where id = $1`,
        [leadId, estado, iso(ahora)],
      );
    },

    async actualizarEmail(leadId, email, ahora) {
      await sql.query('update captacion.leads set email = $2, actualizado_en = $3 where id = $1', [leadId, email, iso(ahora)]);
    },

    async cerrarOtpVigente(leadId, estado, ahora) {
      await sql.query(`update captacion.otp set estado = $2, cerrado_en = $3 where lead_id = $1 and estado = 'vigente'`, [leadId, estado, iso(ahora)]);
    },

    async insertarOtp(i) {
      await sql.query('insert into captacion.otp (id, cliente_id, lead_id, codigo_hash, expira_en, creado_en) values ($1, $2, $3, $4, $5, $6)', [
        i.id, i.clienteId, i.leadId, i.codigoHash, iso(i.expiraEn), iso(i.ahora),
      ]);
    },

    async ultimoOtp(leadId) {
      const { rows } = await sql.query<{ id: string; codigo_hash: string; expira_en: unknown; intentos: number; estado: EstadoOtpNombre }>(
        `select id, codigo_hash, expira_en, intentos, estado from captacion.otp where lead_id = $1 order by (estado = 'vigente') desc, creado_en desc limit 1 for update`,
        [leadId],
      );
      const r = rows[0];
      return r ? ({ id: r.id, codigoHash: r.codigo_hash, expiraEn: new Date(r.expira_en as string), intentos: r.intentos, estado: r.estado } satisfies OtpGuardado) : null;
    },

    async actualizarOtp(id, c) {
      await sql.query(`update captacion.otp set intentos = $2, estado = $3, cerrado_en = case when $3 = 'vigente' then null else $4::timestamptz end where id = $1`, [id, c.intentos, c.estado, iso(c.ahora)]);
    },

    async registrarEnvio(i) {
      await sql.query('insert into captacion.envios_limitados (cliente_id, tipo, telefono_hmac, ip_hmac, lead_id, creado_en) values ($1, $2, $3, $4, $5, $6)', [
        i.clienteId, i.tipo, i.telefonoHmac, i.ipHmac, i.leadId, iso(i.ahora),
      ]);
    },

    async publicarEvento(tipo, payload, clienteId, correlationId) {
      await sql.query('select shared.publicar_evento($1, $2::jsonb, $3, $4)', [tipo, JSON.stringify(payload), clienteId, correlationId]);
    },

    async insertarContactoB2B(i) {
      const { rows } = await sql.query<{ id: string }>(
        `insert into captacion.contactos_b2b (nombre, empresa, email, servicio, mensaje, consentimiento_version, consentido_en, creado_en)
         values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
        [i.nombre, i.empresa, i.email, i.servicio, i.mensaje, i.consentimientoVersion, iso(i.ahora)],
      );
      return rows[0]!.id;
    },
  };
}
