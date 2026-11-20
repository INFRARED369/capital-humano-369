-- =====================================================================
-- Vacantes · reglas operativas versionadas y auditadas (dueño: vacantes/panel)
-- §1 regla 5, D6, D7, DSH-04, DSH-06, S3, S4, NFR-SEG-09, NFR-ESC-06.
--
-- * Las reglas se validan con Zod (ReglasVacanteSchema) en la edge function `panel-reglas`;
--   aquí solo lo mínimo: objeto, llaves conocidas, bloques objeto, ≤ 64 KB.
-- * Escritura SOLO por funciones security definer ejecutables por service_role. La edge function
--   verifica la sesión (Supabase Auth) y fija `request.jwt.claims` de ese usuario en la transacción;
--   las funciones deciden con auth.uid() + shared.es_admin()/puede_operar_vacante().
--   authenticated NO puede ejecutarlas por PostgREST: así nadie se salta la validación Zod.
-- * Permisos: reglas → admin o reclutador asignado (el calendario de Zoho solo admin);
--   alta de cliente/vacante/asignación → solo admin. El rol cliente es solo lectura (S3).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Diff estructural (mismo formato que src/domains/vacantes/domain/diff.ts):
-- [{ruta:'agenda.cupo_diario', antes:10, despues:5}, …] ordenado por ruta; arreglos = hojas;
-- lo ausente vale null; un objeto ausente frente a un objeto vale {}.
-- ---------------------------------------------------------------------
create or replace function config.diff_jsonb(p_a jsonb, p_b jsonb, p_ruta text default '')
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_a jsonb := nullif(p_a, 'null'::jsonb);
  v_b jsonb := nullif(p_b, 'null'::jsonb);
  v_res jsonb := '[]'::jsonb;
  v_k text;
begin
  if v_a is null and jsonb_typeof(v_b) = 'object' then v_a := '{}'::jsonb; end if;
  if v_b is null and jsonb_typeof(v_a) = 'object' then v_b := '{}'::jsonb; end if;
  if jsonb_typeof(v_a) = 'object' and jsonb_typeof(v_b) = 'object' then
    for v_k in
      select k from (select jsonb_object_keys(v_a) as k union select jsonb_object_keys(v_b)) s order by k collate "C"
    loop
      v_res := v_res || config.diff_jsonb(v_a -> v_k, v_b -> v_k, case when p_ruta = '' then v_k else p_ruta || '.' || v_k end);
    end loop;
    return v_res;
  end if;
  if coalesce(nullif(p_a, 'null'::jsonb), 'null'::jsonb) is distinct from coalesce(nullif(p_b, 'null'::jsonb), 'null'::jsonb) then
    return jsonb_build_array(jsonb_build_object('ruta', p_ruta, 'antes', coalesce(p_a, 'null'::jsonb), 'despues', coalesce(p_b, 'null'::jsonb)));
  end if;
  return v_res;
end $$;

-- La auditoría también es append-only (S4: nadie reescribe la historia).
create or replace function config.prohibir_mutacion_auditoria() returns trigger
language plpgsql as $$ begin raise exception 'La auditoría de reglas es inmutable'; end $$;
create trigger vacantes_reglas_auditoria_inmutable before update or delete on config.vacantes_reglas_auditoria
  for each row execute function config.prohibir_mutacion_auditoria();
create index if not exists vacantes_reglas_auditoria_vacante on config.vacantes_reglas_auditoria (vacante_id, id);

-- ---------------------------------------------------------------------
-- Validación mínima (la completa es Zod en el servidor).
-- ---------------------------------------------------------------------
create or replace function config.validar_reglas_minimo(p_reglas jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_reglas is null or jsonb_typeof(p_reglas) <> 'object'
     or octet_length(p_reglas::text) > 65536
     or exists (select 1 from jsonb_object_keys(p_reglas) k where k not in ('agenda', 'mensajes', 'zoho_calendar_uid'))
     or (p_reglas ? 'agenda' and jsonb_typeof(p_reglas -> 'agenda') <> 'object')
     or (p_reglas ? 'mensajes' and jsonb_typeof(p_reglas -> 'mensajes') <> 'object')
     or (p_reglas ? 'zoho_calendar_uid' and jsonb_typeof(p_reglas -> 'zoho_calendar_uid') <> 'string') then
    raise exception 'REGLAS_INVALIDAS' using errcode = '22023';
  end if;
end $$;

-- Inserta la versión siguiente + auditoría. Interna (sin permisos propios): la llaman las públicas.
create or replace function config.insertar_version(p_vacante uuid, p_cliente uuid, p_reglas jsonb, p_anteriores jsonb, p_usuario uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_version int;
  v_diff jsonb := config.diff_jsonb(coalesce(p_anteriores, '{}'::jsonb), p_reglas);
  v_creado timestamptz := now();
begin
  select coalesce(max(version), 0) + 1 into v_version from config.vacantes_reglas where vacante_id = p_vacante;
  insert into config.vacantes_reglas (vacante_id, version, cliente_id, reglas, creado_por, creado_en)
  values (p_vacante, v_version, p_cliente, p_reglas, p_usuario, v_creado);
  insert into config.vacantes_reglas_auditoria (vacante_id, cliente_id, version, usuario_id, diff, creado_en)
  values (p_vacante, p_cliente, v_version, p_usuario, v_diff, v_creado);
  return jsonb_build_object('vacante_id', p_vacante, 'version', v_version, 'diff', v_diff, 'sin_cambios', false, 'creado_en', v_creado);
end $$;

-- ---------------------------------------------------------------------
-- DSH-04 · Guardar reglas (nueva versión inmutable + auditoría). Control optimista con p_version_base
-- (versión que el editor cargó; 0 si no había). Mismas reglas → no crea versión (sin_cambios).
-- ---------------------------------------------------------------------
create or replace function config.guardar_reglas(p_vacante uuid, p_reglas jsonb, p_version_base int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_usuario uuid := auth.uid();
  v_cliente uuid;
  v_actual int;
  v_anteriores jsonb;
begin
  if v_usuario is null then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;
  select v.cliente_id into v_cliente from shared.vacantes v where v.id = p_vacante;
  if not found then
    raise exception 'NO_ENCONTRADA' using errcode = 'P0002';
  end if;
  if not shared.puede_operar_vacante(p_vacante) then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;
  perform config.validar_reglas_minimo(p_reglas);

  -- Serializa a los editores de la misma vacante (la versión siguiente se calcula bajo el lock).
  perform pg_advisory_xact_lock(hashtext('config.guardar_reglas:' || p_vacante::text));
  select r.version, r.reglas into v_actual, v_anteriores
  from config.vacantes_reglas r where r.vacante_id = p_vacante order by r.version desc limit 1;
  v_actual := coalesce(v_actual, 0);

  if p_version_base is not null and p_version_base <> v_actual then
    raise exception 'VERSION_CONFLICTO' using errcode = '40001';
  end if;
  -- El calendario de Zoho decide a dónde van los eventos: solo admin lo cambia.
  if not shared.es_admin() and (p_reglas -> 'zoho_calendar_uid') is distinct from (v_anteriores -> 'zoho_calendar_uid') then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;
  if v_anteriores is not null and v_anteriores = p_reglas then
    return jsonb_build_object('vacante_id', p_vacante, 'version', v_actual, 'diff', '[]'::jsonb, 'sin_cambios', true);
  end if;
  return config.insertar_version(p_vacante, v_cliente, p_reglas, v_anteriores, v_usuario);
end $$;

-- ---------------------------------------------------------------------
-- NFR-ESC-06 · Alta sin código (solo admin).
-- ---------------------------------------------------------------------
create or replace function config.crear_cliente(p_nombre text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null or not shared.es_admin() then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;
  insert into shared.clientes (nombre) values (btrim(p_nombre)) returning id into v_id;
  return v_id;
end $$;

create or replace function config.crear_vacante(p_cliente uuid, p_slug text, p_codigo text, p_nombre text, p_reglas jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_version jsonb;
begin
  if auth.uid() is null or not shared.es_admin() then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;
  if not exists (select 1 from shared.clientes c where c.id = p_cliente) then
    raise exception 'NO_ENCONTRADA' using errcode = 'P0002';
  end if;
  if p_reglas is not null then
    perform config.validar_reglas_minimo(p_reglas);
  end if;
  insert into shared.vacantes (cliente_id, slug, codigo, nombre) values (p_cliente, p_slug, p_codigo, btrim(p_nombre)) returning id into v_id;
  if p_reglas is not null then
    v_version := config.insertar_version(v_id, p_cliente, p_reglas, null, auth.uid());
  end if;
  return jsonb_build_object('vacante_id', v_id, 'version', v_version -> 'version');
end $$;

-- Asigna un usuario EXISTENTE de Supabase Auth (invitado desde el dashboard de Auth) a una vacante.
create or replace function config.asignar_usuario(p_email text, p_rol text, p_vacante uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_cliente uuid;
begin
  if auth.uid() is null or not shared.es_admin() then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;
  if p_rol not in ('reclutador', 'cliente') then
    raise exception 'ROL_INVALIDO' using errcode = '22023';
  end if;
  select v.cliente_id into v_cliente from shared.vacantes v where v.id = p_vacante;
  if not found then
    raise exception 'NO_ENCONTRADA' using errcode = 'P0002';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
  if v_user is null then
    raise exception 'USUARIO_NO_ENCONTRADO' using errcode = 'P0002';
  end if;
  insert into shared.usuarios_roles (user_id, rol, cliente_id) values (v_user, p_rol, v_cliente) on conflict do nothing;
  insert into shared.usuarios_vacantes (user_id, vacante_id, cliente_id) values (v_user, p_vacante, v_cliente) on conflict do nothing;
  return v_user;
end $$;

-- ---------------------------------------------------------------------
-- Lectura para el panel: historial de cambios con el correo del autor (S4). Respeta S1.
-- ---------------------------------------------------------------------
create or replace function config.historial_reglas(p_vacante uuid, p_limite int default 50)
returns table (version int, usuario_id uuid, usuario_email text, creado_en timestamptz, diff jsonb)
language sql stable security definer set search_path = '' as $$
  select a.version, a.usuario_id, u.email::text, a.creado_en, a.diff
  from config.vacantes_reglas_auditoria a
  left join auth.users u on u.id = a.usuario_id
  where a.vacante_id = p_vacante and shared.puede_ver_vacante(p_vacante)
  order by a.id desc
  limit least(greatest(coalesce(p_limite, 50), 1), 200);
$$;

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
revoke all on function config.diff_jsonb(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function config.validar_reglas_minimo(jsonb) from public, anon, authenticated;
revoke all on function config.insertar_version(uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function config.guardar_reglas(uuid, jsonb, int) from public, anon, authenticated;
revoke all on function config.crear_cliente(text) from public, anon, authenticated;
revoke all on function config.crear_vacante(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function config.asignar_usuario(text, text, uuid) from public, anon, authenticated;
revoke all on function config.historial_reglas(uuid, int) from public, anon;
revoke all on function config.prohibir_mutacion_auditoria() from public, anon, authenticated;

grant execute on function config.diff_jsonb(jsonb, jsonb, text), config.validar_reglas_minimo(jsonb) to service_role;
grant execute on function config.guardar_reglas(uuid, jsonb, int), config.crear_cliente(text),
  config.crear_vacante(uuid, text, text, text, jsonb), config.asignar_usuario(text, text, uuid) to service_role;
grant execute on function config.historial_reglas(uuid, int) to authenticated, service_role;
