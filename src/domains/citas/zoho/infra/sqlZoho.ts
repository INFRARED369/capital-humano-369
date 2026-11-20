/**
 * Implementación SQL de los puertos de citas/zoho sobre SqlClient (PGlite en pruebas,
 * driver Postgres en edge functions con service_role).
 * Tablas propias: citas.zoho_eventos, citas.zoho_alertas. Kernel: shared.leer_outbox/avanzar_outbox,
 * shared.encolar/tomar/completar/fallar/recuperar_vencidos. Reglas: config.reglas_vigentes.
 */
import type { Clock } from '@shared/clock.ts';
import type { Logger } from '@shared/logger.ts';
import type { SqlClient } from '@shared/sql.ts';
import type {
  AlertaZoho, AlertasPort, CalendarioExternoPort, CitasVigentesPort, ColaSyncPort, DepsReconciliacion, DepsWorker,
  EstadoSync, IngestaPort, IngestaTx, NuevoRegistro, RangoFechas, RegistroZoho, ZohoRepo,
} from '../application/puertos.ts';
import { COLA_ZOHO, CONSUMIDOR_ZOHO } from '../application/worker.ts';
import { TIPOS_CONSUMIDOS } from '../application/ingesta.ts';

type Fila = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const texto = (v: unknown): string | null => (v == null ? null : String(v));

const COLUMNAS = `cita_id, cliente_id, vacante_id, lead_id, zoho_calendar_uid, zoho_event_uid, uid_propio, estado_sync, vigente,
  inicio, fin, folio, nombre_pila, intentos`;

function aRegistro(f: Fila): RegistroZoho {
  return {
    citaId: String(f.cita_id), clienteId: String(f.cliente_id), vacanteId: String(f.vacante_id), leadId: texto(f.lead_id),
    zohoCalendarUid: texto(f.zoho_calendar_uid), zohoEventUid: texto(f.zoho_event_uid), uidPropio: String(f.uid_propio),
    estadoSync: f.estado_sync as EstadoSync, vigente: Boolean(f.vigente), inicio: iso(f.inicio), fin: iso(f.fin),
    folio: String(f.folio), nombrePila: texto(f.nombre_pila), intentos: Number(f.intentos),
  };
}

async function obtener(sql: SqlClient, citaId: string): Promise<RegistroZoho | null> {
  const { rows } = await sql.query<Fila>(`select ${COLUMNAS} from citas.zoho_eventos where cita_id = $1`, [citaId]);
  return rows[0] ? aRegistro(rows[0]) : null;
}

async function registrarAlerta(sql: SqlClient, a: AlertaZoho): Promise<void> {
  await sql.query(
    `insert into citas.zoho_alertas (cliente_id, vacante_id, cita_id, tipo, detalle) values ($1, $2, $3, $4, $5::jsonb)`,
    [a.clienteId, a.vacanteId, a.citaId, a.tipo, JSON.stringify(a.detalle)],
  );
}

export function crearZohoRepoSql(sql: SqlClient): ZohoRepo {
  return {
    obtener: (citaId) => obtener(sql, citaId),
    async marcarSincronizado(citaId, zohoEventUid) {
      await sql.query(
        `update citas.zoho_eventos set zoho_event_uid = $2, estado_sync = 'sincronizado', ultimo_error = null,
           sincronizado_en = now(), actualizado_en = now() where cita_id = $1`, [citaId, zohoEventUid]);
    },
    async marcarBorrado(citaId) {
      await sql.query(
        `update citas.zoho_eventos set estado_sync = 'borrado', vigente = false, ultimo_error = null,
           sincronizado_en = now(), actualizado_en = now() where cita_id = $1`, [citaId]);
    },
    async marcarFalla(citaId, mensaje, definitiva) {
      await sql.query(
        `update citas.zoho_eventos set intentos = intentos + 1, ultimo_error = left($2, 500),
           estado_sync = case when $3 then 'error' else estado_sync end, actualizado_en = now() where cita_id = $1`,
        [citaId, mensaje, definitiva]);
    },
    async vigentesEnRango(r: RangoFechas) {
      const { rows } = await sql.query<Fila>(
        `select ${COLUMNAS} from citas.zoho_eventos where vigente and estado_sync <> 'reemplazado'
           and inicio >= $1 and inicio < $2 order by inicio`, [r.desde, r.hasta]);
      return rows.map(aRegistro);
    },
    async corregir(citaId, c) {
      await sql.query(
        `update citas.zoho_eventos set inicio = coalesce($2, inicio), fin = coalesce($3, fin), vigente = coalesce($4, vigente),
           zoho_calendar_uid = coalesce($5, zoho_calendar_uid), estado_sync = coalesce($6, estado_sync), actualizado_en = now()
         where cita_id = $1`,
        [citaId, c.inicio ?? null, c.fin ?? null, c.vigente ?? null, c.zohoCalendarUid ?? null, c.estadoSync ?? null]);
    },
  };
}

export const crearAlertasSql = (sql: SqlClient): AlertasPort => ({ registrar: (a) => registrarAlerta(sql, a) });

export function crearColaSql(sql: SqlClient): ColaSyncPort {
  return {
    async recuperarVencidos() {
      const { rows } = await sql.query<{ n: number }>(`select shared.recuperar_vencidos() as n`);
      return Number(rows[0]?.n ?? 0);
    },
    async tomar(n, vtSeg) {
      const { rows } = await sql.query<{ id: unknown; payload: { cita_id?: unknown }; intentos: unknown }>(
        `select id::text as id, payload, intentos from shared.tomar($1, $2, $3)`, [COLA_ZOHO, n, vtSeg]);
      return rows.map((f) => ({ id: String(f.id), citaId: String(f.payload?.cita_id), intentos: Number(f.intentos) }));
    },
    async completar(id) {
      await sql.query(`select shared.completar($1::bigint)`, [id]);
    },
    async fallar(id, mensaje, backoffSeg) {
      const { rows } = await sql.query<{ r: 'reintento' | 'dead_letter' }>(`select shared.fallar($1::bigint, $2, $3) as r`, [id, mensaje, backoffSeg]);
      return rows[0]!.r;
    },
    async fallarDefinitivo(id, mensaje) {
      await sql.query(`select shared.fallar_definitivo($1::bigint, $2)`, [id, mensaje]);
      return 'dead_letter';
    },
  };
}

export async function calendarioDeVacante(sql: SqlClient, vacanteId: string): Promise<string | null> {
  const { rows } = await sql.query<{ cal: string | null }>(`select reglas->>'zoho_calendar_uid' as cal from config.reglas_vigentes($1)`, [vacanteId]);
  return rows[0]?.cal ?? null;
}

function ingestaTx(tx: SqlClient): IngestaTx {
  return {
    async leer(n) {
      const { rows } = await tx.query<{ id: string; evento_id: string; tipo: string; payload: unknown }>(
        `select id::text as id, evento_id, tipo, payload from shared.leer_outbox($1, $2::text[], $3)`, [CONSUMIDOR_ZOHO, TIPOS_CONSUMIDOS, n]);
      return rows.map((f) => ({ id: f.id, eventoId: String(f.evento_id), tipo: f.tipo, payload: f.payload }));
    },
    async avanzar(ultimoId) {
      await tx.query(`select shared.avanzar_outbox($1, $2::bigint)`, [CONSUMIDOR_ZOHO, ultimoId]);
    },
    calendarioDe: (v) => calendarioDeVacante(tx, v),
    obtener: (c) => obtener(tx, c),
    async insertar(r: NuevoRegistro) {
      const { rows } = await tx.query(
        `insert into citas.zoho_eventos (cita_id, cliente_id, vacante_id, lead_id, zoho_calendar_uid, zoho_event_uid, uid_propio,
           estado_sync, inicio, fin, folio, nombre_pila)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (cita_id) do nothing returning 1`,
        [r.citaId, r.clienteId, r.vacanteId, r.leadId, r.zohoCalendarUid, r.zohoEventUid, r.uidPropio, r.estadoSync, r.inicio, r.fin, r.folio, r.nombrePila]);
      return rows.length > 0;
    },
    async marcar(citaId, c) {
      await tx.query(
        `update citas.zoho_eventos set vigente = $2, estado_sync = $3,
           zoho_event_uid = case when $4 then null else zoho_event_uid end, actualizado_en = now() where cita_id = $1`,
        [citaId, c.vigente, c.estadoSync, c.quitarEventUid ?? false]);
    },
    async encolar(citaId, clienteId, llave) {
      await tx.query(`select shared.encolar($1, jsonb_build_object('cita_id', $2::uuid), $3, 5::smallint, $4::uuid, now(), 3::smallint)`,
        [COLA_ZOHO, citaId, llave, clienteId]);
    },
    alertar: (a) => registrarAlerta(tx, a),
  };
}

export const crearIngestaSql = (sql: SqlClient): IngestaPort => ({
  enTransaccion: (fn) => sql.transaction((tx) => fn(ingestaTx(tx))),
});

/**
 * CitasVigentesPort derivado de citas.zoho_eventos. SOLO para pruebas o como respaldo:
 * en producción el orquestador inyecta una implementación que consulta citas.citas.
 */
export function crearCitasVigentesDesdeZohoSql(sql: SqlClient): CitasVigentesPort {
  return {
    async vigentes(r) {
      const regs = await crearZohoRepoSql(sql).vigentesEnRango(r);
      return regs.map(({ citaId, inicio, fin }) => ({ citaId, inicio, fin }));
    },
  };
}

export interface ConfigDepsZoho {
  sql: SqlClient;
  calendario: CalendarioExternoPort;
  clock: Clock;
  logger: Logger;
  panelUrl: string;
  zonaHoraria?: string;
}

export function crearDepsZohoSql(c: ConfigDepsZoho): DepsWorker {
  return {
    repo: crearZohoRepoSql(c.sql),
    calendario: c.calendario,
    cfgEvento: { panelUrl: c.panelUrl, zonaHoraria: c.zonaHoraria ?? 'America/Mexico_City' },
    logger: c.logger,
    cola: crearColaSql(c.sql),
    alertas: crearAlertasSql(c.sql),
    ingesta: crearIngestaSql(c.sql),
  };
}

export function crearDepsReconciliacionSql(c: ConfigDepsZoho & { citasVigentes?: CitasVigentesPort }): DepsReconciliacion {
  const base = crearDepsZohoSql(c);
  return {
    repo: base.repo, calendario: base.calendario, cfgEvento: base.cfgEvento, logger: base.logger, alertas: base.alertas, clock: c.clock,
    citasVigentes: c.citasVigentes ?? crearCitasVigentesDesdeZohoSql(c.sql),
    calendarioDe: (v) => calendarioDeVacante(c.sql, v),
  };
}
