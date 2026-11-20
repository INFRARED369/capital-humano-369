/** Datos semilla reutilizables entre dominios. Inserta como superusuario. */
import type { SqlClient } from '../../src/shared/sql.ts';

export async function crearCliente(sql: SqlClient, nombre = 'Cliente de prueba'): Promise<string> {
  const { rows } = await sql.query<{ id: string }>('insert into shared.clientes (nombre) values ($1) returning id', [nombre]);
  return rows[0]!.id;
}

export async function crearVacante(
  sql: SqlClient,
  opts: { clienteId?: string; slug?: string; codigo?: string; nombre?: string } = {},
): Promise<{ vacanteId: string; clienteId: string }> {
  const clienteId = opts.clienteId ?? (await crearCliente(sql));
  const slug = opts.slug ?? `vacante-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await sql.query<{ id: string }>(
    'insert into shared.vacantes (cliente_id, slug, codigo, nombre) values ($1, $2, $3, $4) returning id',
    [clienteId, slug, opts.codigo ?? slug.toUpperCase(), opts.nombre ?? slug],
  );
  return { vacanteId: rows[0]!.id, clienteId };
}

export async function crearUsuario(
  sql: SqlClient,
  rol: 'admin' | 'reclutador' | 'cliente',
  opts: { clienteId?: string; vacantes?: string[] } = {},
): Promise<string> {
  const { rows } = await sql.query<{ id: string }>('insert into auth.users default values returning id');
  const userId = rows[0]!.id;
  await sql.query('insert into shared.usuarios_roles (user_id, rol, cliente_id) values ($1, $2, $3)', [userId, rol, opts.clienteId ?? null]);
  for (const v of opts.vacantes ?? []) {
    await sql.query('insert into shared.usuarios_vacantes (user_id, vacante_id, cliente_id) select $1, id, cliente_id from shared.vacantes where id = $2', [userId, v]);
  }
  return userId;
}

/** Guarda una versión de reglas (como superusuario; el panel usa config.guardar_reglas). */
export async function guardarReglas(sql: SqlClient, vacanteId: string, reglas: unknown): Promise<number> {
  const { rows } = await sql.query<{ version: number }>(
    `insert into config.vacantes_reglas (vacante_id, version, cliente_id, reglas)
     select $1, coalesce(max(r.version), 0) + 1, v.cliente_id, $2::jsonb
     from shared.vacantes v left join config.vacantes_reglas r on r.vacante_id = v.id
     where v.id = $1 group by v.cliente_id returning version`,
    [vacanteId, JSON.stringify(reglas)],
  );
  return rows[0]!.version;
}
