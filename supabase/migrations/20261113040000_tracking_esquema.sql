-- =====================================================================
-- Tracking · recorrido del visitante (TRK-06, TRK-07, NFR-ESC-03, T3)
-- Dueño: dominio tracking.
-- * tracking.eventos: particionada por mes (rango sobre creado_en) + partición default.
-- * Idempotencia por event_id: en tablas particionadas la llave única debe incluir la llave
--   de partición, así que la deduplicación global vive en tracking.eventos_ids (PK event_id).
-- * Sin consentimiento NO hay fila cruda: solo se suma un conteo anónimo en agregados_diarios.
-- * Los envíos a CAPI/GA4 se encolan en shared.cola ('tracking-capi') en la misma transacción
--   y el payload de la cola no lleva PII (solo destino, event_id y creado_en).
-- =====================================================================

create table tracking.eventos (
  event_id uuid not null,
  creado_en timestamptz not null default now(),
  nombre text not null check (nombre ~ '^[A-Za-z0-9]{2,40}$'),
  fuente text not null check (fuente in ('navegador', 'servidor')),
  consentimiento boolean not null,
  visitor_id uuid,
  lead_id uuid,
  vacante_id uuid,
  cliente_id uuid not null,
  content_category text check (length(content_category) <= 60),
  origen text not null default 'directo' check (length(origen) <= 40),
  utm_source text check (length(utm_source) <= 100),
  utm_medium text check (length(utm_medium) <= 100),
  utm_campaign text check (length(utm_campaign) <= 150),
  utm_content text check (length(utm_content) <= 150),
  utm_term text check (length(utm_term) <= 150),
  gclid text check (length(gclid) <= 200),
  fbc text check (length(fbc) <= 600),
  fbp text check (length(fbp) <= 100),
  referrer_host text check (length(referrer_host) <= 255),
  pagina text check (length(pagina) <= 300),
  ip inet,                 -- completa ≤ 7 días; luego /24 (IPv4) o /48 (IPv6) — R5
  ciudad text check (length(ciudad) <= 100),
  region text check (length(region) <= 100),
  pais text check (length(pais) <= 2),
  user_agent text check (length(user_agent) <= 500),
  propiedades jsonb not null default '{}'::jsonb,
  primary key (event_id, creado_en),
  -- política: sin consentimiento no se guarda IP, cookie ni visitor_id
  check (consentimiento or (visitor_id is null and ip is null and fbc is null and fbp is null and gclid is null and user_agent is null))
) partition by range (creado_en);

create table tracking.eventos_default partition of tracking.eventos default;
create index eventos_vacante_creado on tracking.eventos (vacante_id, creado_en);
create index eventos_visitor on tracking.eventos (visitor_id, creado_en desc) where visitor_id is not null;
create index eventos_lead on tracking.eventos (lead_id) where lead_id is not null;
create index eventos_event_id on tracking.eventos (event_id);

-- Deduplicación global (T3): una fila por event_id, sin importar la partición.
create table tracking.eventos_ids (
  event_id uuid primary key,
  creado_en timestamptz not null,
  cliente_id uuid not null
);

-- Vínculo lead ↔ visitante (desde LeadCreado). Permite enriquecer Schedule/offline con fbc/fbp/IP/UA.
create table tracking.leads (
  lead_id uuid primary key,
  visitor_id uuid,
  event_id uuid not null,
  vacante_id uuid,
  cliente_id uuid not null,
  origen text not null default 'directo',
  creado_en timestamptz not null default now()
);
create index leads_visitor on tracking.leads (visitor_id) where visitor_id is not null;

-- Conteos anónimos (sin lead_id, IP ni visitor_id): sin consentimiento y crudos vencidos (R4). Sin límite de retención.
create table tracking.agregados_diarios (
  dia date not null,
  vacante_id uuid,
  cliente_id uuid not null,
  origen text not null,
  utm_source text,
  utm_campaign text,
  nombre text not null,
  consentimiento boolean not null,
  n bigint not null check (n >= 0),
  constraint agregados_diarios_llave unique nulls not distinct (dia, vacante_id, cliente_id, origen, utm_source, utm_campaign, nombre, consentimiento)
);
create index agregados_vacante_dia on tracking.agregados_diarios (vacante_id, dia);

alter table tracking.eventos enable row level security;
alter table tracking.eventos_default enable row level security;
alter table tracking.eventos_ids enable row level security;
alter table tracking.leads enable row level security;
alter table tracking.agregados_diarios enable row level security;

-- Panel: solo columnas sin datos personales (sin ip, user_agent, visitor_id, fbc, fbp, gclid, lead_id).
grant select (event_id, creado_en, nombre, fuente, vacante_id, cliente_id, content_category, origen, utm_source, utm_medium, utm_campaign, utm_content, pagina, ciudad, region, pais)
  on tracking.eventos to authenticated;
grant select on tracking.agregados_diarios to authenticated;
create policy eventos_panel on tracking.eventos for select to authenticated using (shared.puede_ver_vacante(vacante_id));
create policy agregados_panel on tracking.agregados_diarios for select to authenticated using (shared.puede_ver_vacante(vacante_id));

grant all on tracking.eventos, tracking.eventos_default, tracking.eventos_ids, tracking.leads, tracking.agregados_diarios to service_role;

-- ---------------------------------------------------------------------
-- Particiones mensuales
-- ---------------------------------------------------------------------
-- Crea p_meses particiones desde el mes de p_desde. Idempotente. Si la partición default ya tiene
-- filas de ese rango, las mueve a la partición nueva antes de adjuntarla.
create or replace function tracking.crear_particiones(p_desde date, p_meses int default 3)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_ini date;
  v_fin date;
  v_nombre text;
  v_creadas int := 0;
begin
  for i in 0 .. greatest(p_meses, 1) - 1 loop
    v_ini := (date_trunc('month', p_desde) + make_interval(months => i))::date;
    v_fin := (v_ini + interval '1 month')::date;
    v_nombre := format('eventos_%s', to_char(v_ini, 'YYYY_MM'));
    continue when to_regclass(format('tracking.%I', v_nombre)) is not null;
    execute format('create table tracking.%I (like tracking.eventos including defaults including constraints)', v_nombre);
    execute format(
      'with m as (delete from tracking.eventos_default where creado_en >= %L and creado_en < %L returning *) insert into tracking.%I select * from m',
      v_ini, v_fin, v_nombre);
    execute format('alter table tracking.eventos attach partition tracking.%I for values from (%L) to (%L)', v_nombre, v_ini, v_fin);
    execute format('alter table tracking.%I enable row level security', v_nombre);
    execute format('grant all on tracking.%I to service_role', v_nombre);
    v_creadas := v_creadas + 1;
  end loop;
  return v_creadas;
end $$;

-- Mes actual y los 3 siguientes; el cron de retención mantiene la ventana hacia adelante.
select tracking.crear_particiones(date_trunc('month', now())::date, 4);

-- ---------------------------------------------------------------------
-- Escritura (solo service_role: edge functions tracking-ingest y tracking-capi-worker)
-- ---------------------------------------------------------------------
create or replace function tracking.dia_local(p_ts timestamptz) returns date
language sql immutable set search_path = '' as $$ select (p_ts at time zone 'America/Mexico_City')::date $$;

-- Resuelve la vacante por id, slug o código y toma su cliente. El client_id del navegador solo se usa
-- si la vacante no se encuentra y el cliente existe; si no, el cliente nulo del proyecto (portada).
create or replace function tracking.resolver_vacante(p_vacante_ref text, p_cliente_ref text)
returns table (vacante_id uuid, cliente_id uuid) language plpgsql stable security definer set search_path = '' as $$
begin
  if p_vacante_ref is not null then
    return query
      select v.id, v.cliente_id from shared.vacantes v
      where (p_vacante_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and v.id = p_vacante_ref::uuid)
         or v.slug = p_vacante_ref or v.codigo = p_vacante_ref
      limit 1;
    if found then return; end if;
  end if;
  if p_cliente_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return query select null::uuid, c.id from shared.clientes c where c.id = p_cliente_ref::uuid;
    if found then return; end if;
  end if;
  return query select null::uuid, '00000000-0000-0000-0000-000000000000'::uuid;
end $$;

-- Registra un evento con consentimiento (o de servidor) de forma idempotente y encola sus envíos.
-- p: event_id, nombre, fuente, consentimiento, visitor_id, lead_id, vacante_ref, cliente_ref, content_category,
--    origen, utm_*, gclid, fbc, fbp, referrer_host, pagina, ip, ciudad, region, pais, user_agent, propiedades,
--    creado_en (opcional: solo backfill/pruebas; la ingesta usa now()).
create or replace function tracking.registrar_evento(p jsonb, p_destinos text[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event uuid := (p ->> 'event_id')::uuid;
  v_creado timestamptz := coalesce((p ->> 'creado_en')::timestamptz, now());
  v_vacante uuid;
  v_cliente uuid;
  v_destino text;
begin
  select r.vacante_id, r.cliente_id into v_vacante, v_cliente from tracking.resolver_vacante(p ->> 'vacante_ref', p ->> 'cliente_ref') r;

  insert into tracking.eventos_ids (event_id, creado_en, cliente_id) values (v_event, v_creado, v_cliente)
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('duplicado', true, 'event_id', v_event);
  end if;

  insert into tracking.eventos (event_id, creado_en, nombre, fuente, consentimiento, visitor_id, lead_id, vacante_id, cliente_id,
    content_category, origen, utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid, fbc, fbp, referrer_host, pagina,
    ip, ciudad, region, pais, user_agent, propiedades)
  values (v_event, v_creado, p ->> 'nombre', coalesce(p ->> 'fuente', 'navegador'), coalesce((p ->> 'consentimiento')::boolean, false),
    (p ->> 'visitor_id')::uuid, (p ->> 'lead_id')::uuid, v_vacante, v_cliente,
    p ->> 'content_category', coalesce(p ->> 'origen', 'directo'), p ->> 'utm_source', p ->> 'utm_medium', p ->> 'utm_campaign',
    p ->> 'utm_content', p ->> 'utm_term', p ->> 'gclid', p ->> 'fbc', p ->> 'fbp', p ->> 'referrer_host', p ->> 'pagina',
    (p ->> 'ip')::inet, p ->> 'ciudad', p ->> 'region', p ->> 'pais', p ->> 'user_agent', coalesce(p -> 'propiedades', '{}'::jsonb));

  foreach v_destino in array coalesce(p_destinos, '{}') loop
    if v_destino not in ('meta', 'ga4') then raise exception 'destino inválido: %', v_destino; end if;
    perform shared.encolar('tracking-capi',
      jsonb_build_object('destino', v_destino, 'event_id', v_event, 'creado_en', v_creado),
      v_destino || ':' || v_event::text, 5::smallint, v_cliente, now(), 5::smallint);
  end loop;

  return jsonb_build_object('duplicado', false, 'event_id', v_event, 'vacante_id', v_vacante, 'cliente_id', v_cliente);
end $$;

-- Conteo técnico sin consentimiento: sin IP, cookie, visitor_id ni event_id.
create or replace function tracking.contar_anonimo(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_vacante uuid; v_cliente uuid;
begin
  select r.vacante_id, r.cliente_id into v_vacante, v_cliente from tracking.resolver_vacante(p ->> 'vacante_ref', p ->> 'cliente_ref') r;
  insert into tracking.agregados_diarios as a (dia, vacante_id, cliente_id, origen, utm_source, utm_campaign, nombre, consentimiento, n)
  values (tracking.dia_local(now()), v_vacante, v_cliente, coalesce(p ->> 'origen', 'directo'), p ->> 'utm_source', p ->> 'utm_campaign', p ->> 'nombre', false, 1)
  on conflict on constraint agregados_diarios_llave do update set n = a.n + 1;
end $$;

-- Vínculo lead ↔ visitante (consumidor del outbox, LeadCreado). Idempotente.
create or replace function tracking.registrar_lead(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_vacante uuid; v_cliente uuid;
begin
  select r.vacante_id, r.cliente_id into v_vacante, v_cliente from tracking.resolver_vacante(p ->> 'vacante_ref', p ->> 'cliente_ref') r;
  insert into tracking.leads (lead_id, visitor_id, event_id, vacante_id, cliente_id, origen)
  values ((p ->> 'lead_id')::uuid, (p ->> 'visitor_id')::uuid, (p ->> 'event_id')::uuid, v_vacante, v_cliente, coalesce(p ->> 'origen', 'directo'))
  on conflict (lead_id) do nothing;
end $$;

-- ---------------------------------------------------------------------
-- Vista del funnel para el dashboard (security_invoker: aplica RLS de quien consulta)
-- ---------------------------------------------------------------------
create view tracking.api_funnel_diario with (security_invoker = true) as
select dia, vacante_id, cliente_id, utm_campaign as campana, origen, nombre as evento, sum(n)::bigint as eventos
from (
  select tracking.dia_local(e.creado_en) as dia, e.vacante_id, e.cliente_id, e.utm_campaign, e.origen, e.nombre, count(*)::bigint as n
  from tracking.eventos e
  group by 1, 2, 3, 4, 5, 6
  union all
  select a.dia, a.vacante_id, a.cliente_id, a.utm_campaign, a.origen, a.nombre, a.n
  from tracking.agregados_diarios a
) t
group by dia, vacante_id, cliente_id, utm_campaign, origen, nombre;

grant select on tracking.api_funnel_diario to authenticated, service_role;

revoke all on function tracking.crear_particiones(date, int), tracking.resolver_vacante(text, text), tracking.registrar_evento(jsonb, text[]),
  tracking.contar_anonimo(jsonb), tracking.registrar_lead(jsonb) from public;
grant execute on function tracking.crear_particiones(date, int), tracking.resolver_vacante(text, text), tracking.registrar_evento(jsonb, text[]),
  tracking.contar_anonimo(jsonb), tracking.registrar_lead(jsonb) to service_role;
grant execute on function tracking.dia_local(timestamptz) to authenticated, service_role;
