/**
 * Acceso a datos del dominio (schema comunicacion + API pública de shared: cola y outbox).
 * Depende solo del puerto SqlClient del kernel.
 */
import type { SqlClient } from '@shared/sql.ts';
import type { EventoDominio } from '@shared/eventos.ts';
import type { Canal, EstadoMensaje, TipoMensaje } from '../domain/tipos.ts';

export const COLA = 'comunicacion';

export interface FilaMensaje {
  id: string;
  cliente_id: string;
  vacante_id: string;
  lead_id: string | null;
  cita_id: string | null;
  tipo: TipoMensaje;
  canal: Canal;
  estado: EstadoMensaje;
  llave: string;
  prioridad: number;
  intentos: number;
  variables: Record<string, string> | null;
  codigo_cifrado: string | null;
  correlation_id: string | null;
}

export interface ItemCola {
  id: string;
  payload: { mensaje_id?: string };
}

export interface NuevoMensaje {
  id: string;
  clienteId: string;
  vacanteId: string;
  leadId: string;
  citaId: string | null;
  tipo: TipoMensaje;
  canal: Canal;
  llave: string;
  prioridad: number;
  programadoPara: string | null;
  variables: Record<string, string> | null;
  codigoCifrado: string | null;
  correlationId: string | null;
  maxIntentos: number;
}

export async function insertarYEncolar(tx: SqlClient, m: NuevoMensaje): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `with ins as (
       insert into comunicacion.mensajes (id, cliente_id, vacante_id, lead_id, cita_id, tipo, canal, llave, prioridad, programado_para, variables, codigo_cifrado, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()), $11::jsonb, $12, $13)
       on conflict (llave) do nothing returning id)
     select id from ins union all select id from comunicacion.mensajes where llave = $8 limit 1`,
    [m.id, m.clienteId, m.vacanteId, m.leadId, m.citaId, m.tipo, m.canal, m.llave, m.prioridad, m.programadoPara, m.variables ? JSON.stringify(m.variables) : null, m.codigoCifrado, m.correlationId],
  );
  const id = rows[0]!.id;
  await tx.query(
    `select shared.encolar($1, jsonb_build_object('mensaje_id', $2::text), $3, $4::smallint, $5::uuid, coalesce($6::timestamptz, now()), $7::smallint)`,
    [COLA, id, m.llave, m.prioridad, m.clienteId, m.programadoPara, m.maxIntentos],
  );
  return id;
}

export async function tomar(sql: SqlClient, n: number, vtSeg: number): Promise<ItemCola[]> {
  const { rows } = await sql.query<ItemCola>(`select id::text as id, payload from shared.tomar($1, $2, $3)`, [COLA, n, vtSeg]);
  return rows;
}

/** M3: lease atómico. Solo un worker puede pasar el mensaje a 'enviando'. */
export async function reclamar(sql: SqlClient, mensajeId: string, ahora: Date, vtSeg: number): Promise<FilaMensaje | null> {
  const { rows } = await sql.query<FilaMensaje>(
    `update comunicacion.mensajes set estado = 'enviando', reclamado_hasta = $2::timestamptz + make_interval(secs => $3), actualizado_en = now()
     where id = $1 and (estado in ('pendiente', 'reintento') or (estado = 'enviando' and reclamado_hasta < $2::timestamptz))
     returning id, cliente_id, vacante_id, lead_id, cita_id, tipo, canal, estado, llave, prioridad, intentos, variables, codigo_cifrado, correlation_id`,
    [mensajeId, ahora.toISOString(), vtSeg],
  );
  return rows[0] ?? null;
}

export async function estadoDe(sql: SqlClient, mensajeId: string): Promise<EstadoMensaje | null> {
  const { rows } = await sql.query<{ estado: EstadoMensaje }>(`select estado from comunicacion.mensajes where id = $1`, [mensajeId]);
  return rows[0]?.estado ?? null;
}

export const completarCola = (sql: SqlClient, colaId: string) => sql.query(`select shared.completar($1)`, [colaId]);

/** Termina sin enviar (opt-out, sin contacto). Borra datos de trabajo. */
export async function cerrarSinEnvio(sql: SqlClient, colaId: string, mensajeId: string, estado: 'omitido' | 'cancelado', motivo: string): Promise<void> {
  await sql.transaction(async (tx) => {
    await tx.query(
      `update comunicacion.mensajes set estado = $2, motivo = $3, variables = null, codigo_cifrado = null, reclamado_hasta = null, actualizado_en = now() where id = $1`,
      [mensajeId, estado, motivo],
    );
    await completarCola(tx, colaId);
  });
}

/** M6: completa el item actual y encola uno nuevo visible al inicio de la ventana, sin gastar intentos. */
export async function posponer(sql: SqlClient, colaId: string, m: FilaMensaje, hasta: Date, intentosRestantes: number): Promise<void> {
  await sql.transaction(async (tx) => {
    await tx.query(
      `update comunicacion.mensajes set estado = 'pendiente', programado_para = $2, reclamado_hasta = null, actualizado_en = now() where id = $1`,
      [m.id, hasta.toISOString()],
    );
    await completarCola(tx, colaId);
    await tx.query(`select shared.encolar($1, jsonb_build_object('mensaje_id', $2::text), $3, $4::smallint, $5::uuid, $6::timestamptz, $7::smallint)`, [
      COLA,
      m.id,
      `${m.llave}@${hasta.toISOString()}`,
      m.prioridad,
      m.cliente_id,
      hasta.toISOString(),
      Math.max(1, intentosRestantes),
    ]);
  });
}

export interface RegistroIntento {
  m: FilaMensaje;
  colaId: string;
  intento: number;
  proveedor: string;
  costoMxn: number;
  proveedorId: string | null;
  plantilla: string | null;
}

export async function registrarExito(sql: SqlClient, r: RegistroIntento): Promise<void> {
  await sql.transaction(async (tx) => {
    await insertarIntento(tx, r, 'enviado', null);
    await tx.query(
      `update comunicacion.mensajes set estado = 'enviado', intentos = $2, proveedor = $3, proveedor_id = $4, costo_mxn = costo_mxn + $5,
         plantilla = $6, motivo = null, variables = null, codigo_cifrado = null, reclamado_hasta = null, enviado_en = now(), actualizado_en = now()
       where id = $1`,
      [r.m.id, r.intento, r.proveedor, r.proveedorId, r.costoMxn, r.plantilla],
    );
    await completarCola(tx, r.colaId);
    await publicar(tx, {
      tipo: 'MensajeEnviado',
      payload: { mensaje_id: r.m.id, lead_id: r.m.lead_id, vacante_id: r.m.vacante_id, cliente_id: r.m.cliente_id, canal: r.m.canal, proveedor: r.proveedor, costo_mxn: r.costoMxn, intento: r.intento },
    }, r.m.correlation_id);
  });
}

/**
 * Registra la falla. `definitiva` = la política decidió dead letter (incluye errores permanentes).
 * Devuelve el destino real: 'reintento' | 'dead_letter'.
 */
export async function registrarFallo(
  sql: SqlClient,
  r: RegistroIntento & { motivo: string; definitiva: boolean; backoffSeg: number; enviado: boolean },
): Promise<'reintento' | 'dead_letter'> {
  return sql.transaction(async (tx) => {
    if (r.enviado) await insertarIntento(tx, r, 'error', r.motivo);
    let destino: 'reintento' | 'dead_letter' = 'dead_letter';
    if (!r.definitiva) {
      const { rows } = await tx.query<{ r: 'reintento' | 'dead_letter' }>(`select shared.fallar($1, $2, $3) as r`, [r.colaId, r.motivo, r.backoffSeg]);
      destino = rows[0]!.r;
    } else {
      // Error permanente: no se reintenta; directo a shared.dead_letter (visible para las alertas, NFR-OBS-01)
      // y el mensaje queda 'fallido' (métrica en api_fallos).
      await tx.query(`select shared.fallar_definitivo($1, $2)`, [r.colaId, r.motivo]);
    }
    if (destino === 'dead_letter') {
      await tx.query(
        `update comunicacion.mensajes set estado = 'fallido', intentos = $2, motivo = $3, proveedor = $4, costo_mxn = costo_mxn + $5, plantilla = coalesce($6, plantilla),
           variables = null, codigo_cifrado = null, reclamado_hasta = null, actualizado_en = now() where id = $1`,
        [r.m.id, r.intento, r.motivo, r.proveedor, r.costoMxn, r.plantilla],
      );
      await publicar(tx, { tipo: 'MensajeFallido', payload: { mensaje_id: r.m.id, canal: r.m.canal, cliente_id: r.m.cliente_id, motivo: r.motivo } }, r.m.correlation_id);
    } else {
      await tx.query(
        `update comunicacion.mensajes set estado = 'reintento', intentos = $2, motivo = $3, proveedor = $4, costo_mxn = costo_mxn + $5, reclamado_hasta = null, actualizado_en = now() where id = $1`,
        [r.m.id, r.intento, r.motivo, r.proveedor, r.costoMxn],
      );
    }
    return destino;
  });
}

async function insertarIntento(tx: SqlClient, r: RegistroIntento, resultado: 'enviado' | 'error', error: string | null): Promise<void> {
  await tx.query(
    `insert into comunicacion.intentos (mensaje_id, cliente_id, vacante_id, canal, proveedor, intento, resultado, error, proveedor_id, costo_mxn)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [r.m.id, r.m.cliente_id, r.m.vacante_id, r.m.canal, r.proveedor, r.intento, resultado, error, r.proveedorId, r.costoMxn],
  );
}

export async function publicar(tx: SqlClient, e: EventoDominio, correlationId: string | null): Promise<void> {
  const cliente = (e.payload as { cliente_id: string }).cliente_id;
  await tx.query(`select shared.publicar_evento($1, $2::jsonb, $3::uuid, $4)`, [e.tipo, JSON.stringify(e.payload), cliente, correlationId]);
}

export async function enOptOut(sql: SqlClient, hmac: string): Promise<boolean> {
  const { rows } = await sql.query(`select 1 from comunicacion.opt_out where telefono_hmac = $1`, [hmac]);
  return rows.length > 0;
}

/** M7: cancela mensajes pendientes de una cita (por defecto recordatorios y confirmación). */
export async function cancelarPendientesDeCita(tx: SqlClient, citaId: string, tipos: TipoMensaje[], motivo: string): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `update comunicacion.mensajes set estado = 'cancelado', motivo = $3, variables = null, actualizado_en = now()
     where cita_id = $1 and tipo = any ($2::text[]) and estado in ('pendiente', 'reintento') returning id`,
    [citaId, tipos, motivo],
  );
  return rows.length;
}
