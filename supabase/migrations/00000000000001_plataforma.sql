-- =====================================================================
-- Plataforma (dueño: plataforma)
--  1. Rate limit genérico basado en tabla (NFR-SEG-03). Llaves = HMAC con pepper (sin PII).
--  2. Programación de crons con pg_cron + pg_net (solo donde existen: Supabase real).
--     En PGlite (pruebas) el bloque se omite. Ver docs/runbook.md §Crons.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Rate limit (ventana fija). UNLOGGED: datos efímeros, menos WAL a 500 ev/s.
-- ---------------------------------------------------------------------
create unlogged table shared.rate_limit (
  llave text not null check (length(llave) between 1 and 120),
  ventana_inicio timestamptz not null,
  conteo int not null default 0,
  expira_en timestamptz not null,
  cliente_id uuid,                      -- opcional: límites por tenant (como shared.cola)
  primary key (llave, ventana_inicio)
);
create index rate_limit_expira on shared.rate_limit (expira_en);
alter table shared.rate_limit enable row level security;
-- Sin políticas ni grants a anon/authenticated: solo service_role (edge functions).

-- Incrementa atómicamente el contador de la ventana actual y devuelve si está permitido.
create or replace function shared.rate_limit_consumir(p_llave text, p_limite int, p_ventana_seg int, p_ahora timestamptz default now())
returns table (permitido boolean, conteo int, reinicia_en timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_inicio timestamptz;
  v_conteo int;
begin
  if p_limite < 1 or p_ventana_seg < 1 then raise exception 'rate_limit: límite y ventana deben ser positivos'; end if;
  v_inicio := to_timestamp(floor(extract(epoch from p_ahora) / p_ventana_seg) * p_ventana_seg);
  insert into shared.rate_limit as r (llave, ventana_inicio, conteo, expira_en)
  values (p_llave, v_inicio, 1, v_inicio + make_interval(secs => p_ventana_seg))
  on conflict (llave, ventana_inicio) do update set conteo = r.conteo + 1
  returning r.conteo into v_conteo;
  return query select v_conteo <= p_limite, v_conteo, v_inicio + make_interval(secs => p_ventana_seg);
end $$;

create or replace function shared.rate_limit_purgar(p_ahora timestamptz default now()) returns int
language sql security definer set search_path = '' as $$
  with d as (delete from shared.rate_limit where expira_en < p_ahora returning 1)
  select count(*)::int from d;
$$;

revoke all on function shared.rate_limit_consumir(text, int, int, timestamptz) from public;
revoke all on function shared.rate_limit_purgar(timestamptz) from public;
grant execute on function shared.rate_limit_consumir(text, int, int, timestamptz) to service_role;
grant execute on function shared.rate_limit_purgar(timestamptz) to service_role;
grant all on shared.rate_limit to service_role;

-- ---------------------------------------------------------------------
-- 2. Crons (pg_cron + pg_net). Las edge functions se invocan con la service key que vive
--    en Vault (secretos `project_url` y `service_role_key`, ver runbook). cron.schedule
--    con el mismo nombre reemplaza la tarea: la migración es idempotente.
-- ---------------------------------------------------------------------
do $plataforma$
declare
  v_invocar text := $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/%s',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'x-correlation-id', 'cron-%s-' || to_char(now(), 'YYYYMMDDHH24MI')),
      body := jsonb_build_object('origen', 'cron'),
      timeout_milliseconds := 55000)
  $sql$;
  v_tarea record;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'plataforma: pg_cron/pg_net no disponibles; crons omitidos (entorno de pruebas)';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;

  -- Edge functions programadas: (nombre de la tarea, cron en UTC, función).
  for v_tarea in
    select * from (values
      ('retencion-diaria',      '0 9 * * *',    'retencion-diaria'),       -- 03:00 America/Mexico_City
      ('zoho-reconciliacion',   '*/15 * * * *', 'zoho-reconciliacion'),
      ('comunicacion-worker',   '* * * * *',    'comunicacion-worker'),
      ('zoho-sync-worker',      '* * * * *',    'zoho-sync-worker'),
      ('tracking-capi-worker',  '* * * * *',    'tracking-capi-worker')
    ) as t(nombre, horario, funcion)
  loop
    perform cron.schedule(v_tarea.nombre, v_tarea.horario, format(v_invocar, v_tarea.funcion, v_tarea.nombre));
  end loop;

  -- Tareas SQL puras.
  perform cron.schedule('cola-recuperar-vencidos', '* * * * *', 'select shared.recuperar_vencidos()');
  perform cron.schedule('rate-limit-purgar', '17 * * * *', 'select shared.rate_limit_purgar()');
  perform cron.schedule('cron-historial-purgar', '30 9 * * *',
    $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
end
$plataforma$;
