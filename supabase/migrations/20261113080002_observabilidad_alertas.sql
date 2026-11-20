-- =====================================================================
-- Cierre backend · NFR-OBS-01: alertas automáticas (dueño: plataforma).
--  1. Vistas de lectura por dominio (prefijo api_, solo service_role) para no leer tablas ajenas (CONTRATOS §1).
--  2. shared.alertas (deduplicada por `clave`, sin PII; RLS: solo admin lee).
--  3. shared.evaluar_alertas(p_ahora, p_config): cola atascada, dead letters nuevas, tasa de fallas de OTP,
--     alertas de Zoho no notificadas y retención diaria con errores o sin correr en 26 h.
--  4. shared.alertas_pendientes / shared.alertas_marcar: la edge function `alertas` notifica (webhook/correo).
--  5. Cron `alertas` cada 5 min (mismo patrón pg_cron + pg_net de 00000000000001_plataforma.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. API de lectura por dominio (solo conteos; nada de PII)
-- ---------------------------------------------------------------------
create or replace function captacion.api_metricas_otp(p_desde timestamptz, p_hasta timestamptz)
returns table (emitidos int, bloqueados int)
language sql stable security definer set search_path = '' as $$
  select count(*)::int, count(*) filter (where estado = 'bloqueado')::int
  from captacion.otp where creado_en > p_desde and creado_en <= p_hasta;
$$;

create or replace function comunicacion.api_otp_envios_fallidos(p_desde timestamptz, p_hasta timestamptz)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from comunicacion.mensajes
  where tipo = 'otp' and estado = 'fallido' and actualizado_en > p_desde and actualizado_en <= p_hasta;
$$;

create or replace function citas.api_zoho_alertas_desde(p_tipo text, p_desde_id bigint)
returns table (nuevas int, hasta_id bigint)
language sql stable security definer set search_path = '' as $$
  select count(*)::int, coalesce(max(id), p_desde_id) from citas.zoho_alertas where tipo = p_tipo and id > p_desde_id;
$$;

create or replace function privacidad.api_ultima_retencion()
returns table (registro_id bigint, ejecutado_en timestamptz, errores text[])
language sql stable security definer set search_path = '' as $$
  select id, r.ejecutado_en, array(select jsonb_object_keys(r.errores) order by 1)
  from privacidad.registro_supresiones r where tipo = 'retencion' order by r.ejecutado_en desc, id desc limit 1;
$$;

revoke execute on function captacion.api_metricas_otp(timestamptz, timestamptz), comunicacion.api_otp_envios_fallidos(timestamptz, timestamptz),
  citas.api_zoho_alertas_desde(text, bigint), privacidad.api_ultima_retencion() from public, anon, authenticated;
grant execute on function captacion.api_metricas_otp(timestamptz, timestamptz), comunicacion.api_otp_envios_fallidos(timestamptz, timestamptz),
  citas.api_zoho_alertas_desde(text, bigint), privacidad.api_ultima_retencion() to service_role;

-- ---------------------------------------------------------------------
-- 2. Alertas
-- ---------------------------------------------------------------------
create table shared.alertas (
  id bigint generated always as identity primary key,
  cliente_id uuid not null default '00000000-0000-0000-0000-000000000369',   -- alertas de plataforma: 369
  clave text not null unique check (length(clave) between 1 and 200),       -- deduplicación
  tipo text not null check (tipo in ('cola_atascada', 'dead_letter', 'otp_tasa_fallas', 'zoho', 'retencion_errores', 'retencion_sin_correr')),
  severidad text not null check (severidad in ('aviso', 'critica')),
  detalle jsonb not null default '{}' check (jsonb_typeof(detalle) = 'object' and octet_length(detalle::text) <= 2048),
  creada_en timestamptz not null default now(),
  notificada_en timestamptz,
  canales text check (length(canales) <= 200),
  intentos_notificacion smallint not null default 0,
  ultimo_error text check (length(ultimo_error) <= 300),
  reclamada_hasta timestamptz
);
create index alertas_pendientes on shared.alertas (id) where notificada_en is null;
create index alertas_tipo on shared.alertas (tipo, id desc);
alter table shared.alertas enable row level security;
revoke all on shared.alertas from public, anon, authenticated;
grant select on shared.alertas to authenticated;
grant all on shared.alertas to service_role;
create policy alertas_solo_admin on shared.alertas for select to authenticated using (shared.es_admin());

-- ---------------------------------------------------------------------
-- 3. Evaluación. Umbrales por defecto (sobrescribibles con p_config):
--    cola_atascada_min 5 · otp_ventana_min 60 · otp_umbral 0.15 · otp_min_muestra 10 · retencion_horas 26
-- ---------------------------------------------------------------------
create or replace function shared.evaluar_alertas(p_ahora timestamptz default now(), p_config jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := jsonb_build_object('cola_atascada_min', 5, 'otp_ventana_min', 60, 'otp_umbral', 0.15, 'otp_min_muestra', 10, 'retencion_horas', 26)
             || coalesce(p_config, '{}'::jsonb);
  v_min int := (c ->> 'cola_atascada_min')::int;
  v_hora text := to_char(p_ahora at time zone 'UTC', 'YYYY-MM-DD"T"HH24');
  v_dia text := to_char(p_ahora at time zone 'UTC', 'YYYY-MM-DD');
  v_nuevas int := 0;
  v_tipos text[] := '{}';
  v_n int;
  r record;
  v_desde bigint;
  v_emitidos int; v_bloqueados int; v_fallidos int; v_tasa numeric;
  v_ret record;

  -- inserta deduplicando; cuenta solo las nuevas
begin
  -- Alertas viejas (sin PII, pero no se acumulan): 90 días.
  delete from shared.alertas where id in (select id from shared.alertas where creada_en < p_ahora - interval '90 days' limit 5000);

  -- a) Cola atascada: pendiente visible hace > N min o en_proceso sin avanzar > N min. Una por cola y hora.
  for r in
    select cola, count(*)::int as n from shared.cola
    where (estado = 'pendiente' and visible_desde < p_ahora - make_interval(mins => v_min))
       or (estado = 'en_proceso' and actualizado_en < p_ahora - make_interval(mins => v_min))
    group by cola order by cola
  loop
    insert into shared.alertas (clave, tipo, severidad, detalle, creada_en)
    values ('cola_atascada:' || r.cola || ':' || v_hora, 'cola_atascada', case when r.cola = 'comunicacion' then 'critica' else 'aviso' end,
            jsonb_build_object('cola', r.cola, 'atascados', r.n, 'minutos', v_min), p_ahora)
    on conflict (clave) do nothing;
    get diagnostics v_n = row_count;
    v_nuevas := v_nuevas + v_n;
    if v_n > 0 then v_tipos := array_append(v_tipos, 'cola_atascada'); end if;
  end loop;

  -- b) Dead letters nuevas por cola (marca de agua = hasta_id de la última alerta de esa cola). Sin motivo ni payload.
  for r in select distinct cola from shared.dead_letter order by cola loop
    select coalesce(max((detalle ->> 'hasta_id')::bigint), 0) into v_desde
    from shared.alertas where tipo = 'dead_letter' and detalle ->> 'cola' = r.cola;
    select count(*)::int, coalesce(max(id), v_desde) into v_n, v_desde from shared.dead_letter where cola = r.cola and id > v_desde;
    if v_n > 0 then
      insert into shared.alertas (clave, tipo, severidad, detalle, creada_en)
      values ('dead_letter:' || r.cola || ':' || v_desde, 'dead_letter', case when r.cola = 'comunicacion' then 'critica' else 'aviso' end,
              jsonb_build_object('cola', r.cola, 'nuevas', v_n, 'hasta_id', v_desde), p_ahora)
      on conflict (clave) do nothing;
      get diagnostics v_n = row_count;
      v_nuevas := v_nuevas + v_n;
      if v_n > 0 then v_tipos := array_append(v_tipos, 'dead_letter'); end if;
    end if;
  end loop;

  -- c) Tasa de fallas de OTP en la ventana: (bloqueados por 5 errores + envíos OTP fallidos) / emitidos.
  select m.emitidos, m.bloqueados into v_emitidos, v_bloqueados
  from captacion.api_metricas_otp(p_ahora - make_interval(mins => (c ->> 'otp_ventana_min')::int), p_ahora) m;
  v_fallidos := comunicacion.api_otp_envios_fallidos(p_ahora - make_interval(mins => (c ->> 'otp_ventana_min')::int), p_ahora);
  if v_emitidos >= (c ->> 'otp_min_muestra')::int then
    v_tasa := round((v_bloqueados + v_fallidos)::numeric / v_emitidos, 4);
    if v_tasa > (c ->> 'otp_umbral')::numeric then
      insert into shared.alertas (clave, tipo, severidad, detalle, creada_en)
      values ('otp_tasa_fallas:' || v_hora, 'otp_tasa_fallas', 'critica',
              jsonb_build_object('emitidos', v_emitidos, 'bloqueados', v_bloqueados, 'envios_fallidos', v_fallidos, 'tasa', v_tasa, 'umbral', c -> 'otp_umbral'), p_ahora)
      on conflict (clave) do nothing;
      get diagnostics v_n = row_count;
      v_nuevas := v_nuevas + v_n;
      if v_n > 0 then v_tipos := array_append(v_tipos, 'otp_tasa_fallas'); end if;
    end if;
  end if;

  -- d) Alertas de Zoho aún no notificadas (marca de agua por tipo). Sin ids de cita ni detalle.
  for r in select t from unnest(array['ZOHO_AUTH', 'ZOHO_CONFIG_INCOMPLETA', 'ZOHO_DEAD_LETTER', 'ZOHO_DRIFT']) t loop
    select coalesce(max((detalle ->> 'hasta_id')::bigint), 0) into v_desde
    from shared.alertas where tipo = 'zoho' and detalle ->> 'zoho_tipo' = r.t;
    select z.nuevas, z.hasta_id into v_n, v_desde from citas.api_zoho_alertas_desde(r.t, v_desde) z;
    if v_n > 0 then
      insert into shared.alertas (clave, tipo, severidad, detalle, creada_en)
      values ('zoho:' || r.t || ':' || v_desde, 'zoho', case when r.t in ('ZOHO_AUTH', 'ZOHO_DEAD_LETTER') then 'critica' else 'aviso' end,
              jsonb_build_object('zoho_tipo', r.t, 'nuevas', v_n, 'hasta_id', v_desde), p_ahora)
      on conflict (clave) do nothing;
      get diagnostics v_n = row_count;
      v_nuevas := v_nuevas + v_n;
      if v_n > 0 then v_tipos := array_append(v_tipos, 'zoho'); end if;
    end if;
  end loop;

  -- e) Retención diaria: última corrida con errores (una alerta por corrida) o sin correr en N horas (una por día).
  select * into v_ret from privacidad.api_ultima_retencion();
  if v_ret.registro_id is not null and cardinality(v_ret.errores) > 0 then
    insert into shared.alertas (clave, tipo, severidad, detalle, creada_en)
    values ('retencion_errores:' || v_ret.registro_id, 'retencion_errores', 'critica',
            jsonb_build_object('errores', to_jsonb(v_ret.errores),
                               'ejecutado_en', to_char(v_ret.ejecutado_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"')), p_ahora)
    on conflict (clave) do nothing;
    get diagnostics v_n = row_count;
    v_nuevas := v_nuevas + v_n;
    if v_n > 0 then v_tipos := array_append(v_tipos, 'retencion_errores'); end if;
  end if;
  if v_ret.registro_id is null or v_ret.ejecutado_en < p_ahora - make_interval(hours => (c ->> 'retencion_horas')::int) then
    insert into shared.alertas (clave, tipo, severidad, detalle, creada_en)
    values ('retencion_sin_correr:' || v_dia, 'retencion_sin_correr', 'critica',
            jsonb_build_object('horas', (c ->> 'retencion_horas')::int,
                               'ultima', case when v_ret.ejecutado_en is null then null
                                         else to_char(v_ret.ejecutado_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') end), p_ahora)
    on conflict (clave) do nothing;
    get diagnostics v_n = row_count;
    v_nuevas := v_nuevas + v_n;
    if v_n > 0 then v_tipos := array_append(v_tipos, 'retencion_sin_correr'); end if;
  end if;

  return jsonb_build_object('nuevas', v_nuevas, 'tipos', to_jsonb(array(select distinct x from unnest(v_tipos) x order by 1)));
end $$;

-- ---------------------------------------------------------------------
-- 4. Notificación (lease corto para que dos corridas no notifiquen lo mismo)
-- ---------------------------------------------------------------------
create or replace function shared.alertas_pendientes(p_n int default 50)
returns setof shared.alertas language plpgsql security definer set search_path = '' as $$
begin
  return query
  update shared.alertas a set reclamada_hasta = now() + interval '2 minutes'
  where a.id in (
    select id from shared.alertas
    where notificada_en is null and intentos_notificacion < 5 and (reclamada_hasta is null or reclamada_hasta < now())
    order by id limit p_n for update skip locked)
  returning a.*;
end $$;

create or replace function shared.alertas_marcar(p_ids bigint[], p_ok boolean, p_detalle text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_ok then
    update shared.alertas set notificada_en = now(), canales = left(p_detalle, 200), reclamada_hasta = null, ultimo_error = null
    where id = any (p_ids) and notificada_en is null;
  else
    update shared.alertas set intentos_notificacion = intentos_notificacion + 1, ultimo_error = left(p_detalle, 300), reclamada_hasta = null
    where id = any (p_ids) and notificada_en is null;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function shared.evaluar_alertas(timestamptz, jsonb), shared.alertas_pendientes(int), shared.alertas_marcar(bigint[], boolean, text)
  from public, anon, authenticated;
grant execute on function shared.evaluar_alertas(timestamptz, jsonb), shared.alertas_pendientes(int), shared.alertas_marcar(bigint[], boolean, text)
  to service_role;

-- ---------------------------------------------------------------------
-- 5. Cron (solo donde existen pg_cron y pg_net; en PGlite se omite)
-- ---------------------------------------------------------------------
do $alertas$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'alertas: pg_cron/pg_net no disponibles; cron omitido (entorno de pruebas)';
    return;
  end if;
  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;
  perform cron.schedule('alertas', '*/5 * * * *', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/alertas',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'x-correlation-id', 'cron-alertas-' || to_char(now(), 'YYYYMMDDHH24MI')),
      body := jsonb_build_object('origen', 'cron'),
      timeout_milliseconds := 55000)
  $sql$);
end
$alertas$;
