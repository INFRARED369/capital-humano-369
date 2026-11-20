-- =====================================================================
-- F0 · Migración base del monolito modular (dueño: plataforma)
-- Un schema por dominio, cliente_id (tenant) en toda tabla, RLS deny-by-default,
-- outbox de eventos de dominio y cola con prioridad (sustituye a pgmq: pgmq no
-- tiene prioridad, que M9 exige; esta cola usa FOR UPDATE SKIP LOCKED).
-- Convención de nombres de migración (formato Supabase <14 dígitos>_<nombre>.sql):
--   00000000000000 base · 2026111301NNNN citas · 2026111302NNNN captacion
--   2026111303NNNN comunicacion · 2026111304NNNN tracking
--   2026111305NNNN vacantes/panel/dashboard · 2026111306NNNN privacidad
-- =====================================================================

create schema if not exists shared;
create schema if not exists config;
create schema if not exists captacion;
create schema if not exists citas;
create schema if not exists comunicacion;
create schema if not exists tracking;
create schema if not exists dashboard;
create schema if not exists privacidad;

-- Deny-by-default: nadie (anon/authenticated) usa tablas salvo por políticas explícitas.
revoke all on schema shared, config, captacion, citas, comunicacion, tracking, dashboard, privacidad from public;
grant usage on schema shared, config, captacion, citas, comunicacion, tracking, dashboard to authenticated;
grant usage on schema shared, config, captacion, citas, comunicacion, tracking, dashboard, privacidad to service_role;

-- ---------------------------------------------------------------------
-- Tenants y vacantes
-- ---------------------------------------------------------------------
create table shared.clientes (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid generated always as (id) stored,
  nombre text not null check (length(nombre) between 1 and 200),
  creado_en timestamptz not null default now()
);

create table shared.vacantes (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references shared.clientes(id),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  codigo text not null unique,
  nombre text not null,
  activa boolean not null default true,
  -- F7.4 corte gradual por vacante
  agenda_modo text not null default 'sistema' check (agenda_modo in ('sistema', 'whatsapp')),
  creado_en timestamptz not null default now()
);
create index on shared.vacantes (cliente_id);

-- ---------------------------------------------------------------------
-- Roles del panel (DSH-06): admin · reclutador (sus vacantes) · cliente (lectura de su vacante)
-- ---------------------------------------------------------------------
create table shared.usuarios_roles (
  user_id uuid not null,
  rol text not null check (rol in ('admin', 'reclutador', 'cliente')),
  cliente_id uuid references shared.clientes(id),
  primary key (user_id, rol),
  check (rol = 'admin' or cliente_id is not null)
);

create table shared.usuarios_vacantes (
  user_id uuid not null,
  vacante_id uuid not null references shared.vacantes(id) on delete cascade,
  cliente_id uuid not null references shared.clientes(id),
  primary key (user_id, vacante_id)
);

create or replace function shared.es_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from shared.usuarios_roles where user_id = auth.uid() and rol = 'admin');
$$;

-- Lectura: admin, reclutador asignado a la vacante o cliente dueño asignado a la vacante.
create or replace function shared.puede_ver_vacante(p_vacante uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select shared.es_admin() or exists (
    select 1 from shared.usuarios_vacantes uv
    join shared.usuarios_roles ur on ur.user_id = uv.user_id and ur.rol in ('reclutador', 'cliente')
    where uv.user_id = auth.uid() and uv.vacante_id = p_vacante
  );
$$;

-- Operar (asistencia, evaluación): admin o reclutador asignado. El rol cliente es solo lectura.
create or replace function shared.puede_operar_vacante(p_vacante uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select shared.es_admin() or exists (
    select 1 from shared.usuarios_vacantes uv
    join shared.usuarios_roles ur on ur.user_id = uv.user_id and ur.rol = 'reclutador'
    where uv.user_id = auth.uid() and uv.vacante_id = p_vacante
  );
$$;

alter table shared.clientes enable row level security;
alter table shared.vacantes enable row level security;
alter table shared.usuarios_roles enable row level security;
alter table shared.usuarios_vacantes enable row level security;

grant select on shared.clientes, shared.vacantes, shared.usuarios_roles, shared.usuarios_vacantes to authenticated;
create policy vacantes_lectura on shared.vacantes for select to authenticated using (shared.puede_ver_vacante(id));
create policy clientes_lectura on shared.clientes for select to authenticated
  using (shared.es_admin() or exists (select 1 from shared.usuarios_roles ur where ur.user_id = auth.uid() and ur.cliente_id = clientes.id));
create policy roles_propios on shared.usuarios_roles for select to authenticated using (user_id = auth.uid() or shared.es_admin());
create policy asignaciones_propias on shared.usuarios_vacantes for select to authenticated using (user_id = auth.uid() or shared.es_admin());

-- ---------------------------------------------------------------------
-- Outbox de eventos de dominio
-- ---------------------------------------------------------------------
create table shared.outbox (
  id bigint generated always as identity primary key,
  evento_id uuid not null unique default gen_random_uuid(),
  tipo text not null,
  payload jsonb not null,
  cliente_id uuid not null,
  correlation_id text,
  creado_en timestamptz not null default now(),
  despachado_en timestamptz
);
create index outbox_pendientes on shared.outbox (id) where despachado_en is null;
alter table shared.outbox enable row level security;

create or replace function shared.publicar_evento(p_tipo text, p_payload jsonb, p_cliente uuid, p_correlation text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into shared.outbox (tipo, payload, cliente_id, correlation_id)
  values (p_tipo, p_payload, p_cliente, p_correlation) returning evento_id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Cola con prioridad (comunicación, zoho, tracking). Menor número = mayor prioridad.
-- ---------------------------------------------------------------------
create table shared.cola (
  id bigint generated always as identity primary key,
  cola text not null,
  prioridad smallint not null default 5 check (prioridad between 0 and 9),
  payload jsonb not null,
  cliente_id uuid,
  llave_idempotencia text not null,
  intentos smallint not null default 0,
  max_intentos smallint not null default 3,            -- 1 intento + 2 reintentos (COM-02)
  visible_desde timestamptz not null default now(),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'en_proceso', 'completado', 'cancelado', 'dead_letter')),
  ultimo_error text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (cola, llave_idempotencia)
);
create index cola_disponibles on shared.cola (cola, prioridad, visible_desde, id) where estado = 'pendiente';
alter table shared.cola enable row level security;

create table shared.dead_letter (
  id bigint generated always as identity primary key,
  cola_id bigint not null,
  cola text not null,
  payload jsonb not null,
  cliente_id uuid,
  motivo text not null,
  creado_en timestamptz not null default now()
);
alter table shared.dead_letter enable row level security;

-- Encola de forma idempotente: si la llave ya existe, devuelve el id existente.
create or replace function shared.encolar(p_cola text, p_payload jsonb, p_llave text, p_prioridad smallint default 5,
  p_cliente uuid default null, p_visible_desde timestamptz default now(), p_max_intentos smallint default 3)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into shared.cola (cola, payload, llave_idempotencia, prioridad, cliente_id, visible_desde, max_intentos)
  values (p_cola, p_payload, p_llave, p_prioridad, p_cliente, p_visible_desde, p_max_intentos)
  on conflict (cola, llave_idempotencia) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from shared.cola where cola = p_cola and llave_idempotencia = p_llave;
  end if;
  return v_id;
end $$;

-- Toma hasta p_n mensajes visibles por prioridad; quedan invisibles p_vt segundos (visibility timeout).
create or replace function shared.tomar(p_cola text, p_n int default 10, p_vt int default 60)
returns setof shared.cola language plpgsql security definer set search_path = '' as $$
begin
  return query
  with sel as (
    select id from shared.cola
    where cola = p_cola and estado = 'pendiente' and visible_desde <= now()
    order by prioridad, visible_desde, id
    limit p_n
    for update skip locked
  )
  update shared.cola c set estado = 'en_proceso', intentos = c.intentos + 1,
    visible_desde = now() + make_interval(secs => p_vt), actualizado_en = now()
  from sel where c.id = sel.id
  returning c.*;
end $$;

create or replace function shared.completar(p_id bigint) returns void
language sql security definer set search_path = '' as $$
  update shared.cola set estado = 'completado', actualizado_en = now() where id = p_id;
$$;

-- Registra una falla: reprograma con backoff o mueve a dead letter si se agotaron los intentos.
-- Devuelve 'reintento' o 'dead_letter'.
create or replace function shared.fallar(p_id bigint, p_error text, p_backoff_seg int default 30)
returns text language plpgsql security definer set search_path = '' as $$
declare r shared.cola;
begin
  select * into r from shared.cola where id = p_id for update;
  if r.intentos >= r.max_intentos then
    update shared.cola set estado = 'dead_letter', ultimo_error = left(p_error, 500), actualizado_en = now() where id = p_id;
    insert into shared.dead_letter (cola_id, cola, payload, cliente_id, motivo) values (r.id, r.cola, r.payload, r.cliente_id, left(p_error, 500));
    return 'dead_letter';
  end if;
  update shared.cola set estado = 'pendiente', ultimo_error = left(p_error, 500),
    visible_desde = now() + make_interval(secs => p_backoff_seg), actualizado_en = now() where id = p_id;
  return 'reintento';
end $$;

-- Recupera mensajes 'en_proceso' cuyo visibility timeout venció (worker caído).
create or replace function shared.recuperar_vencidos() returns int
language sql security definer set search_path = '' as $$
  with u as (update shared.cola set estado = 'pendiente', actualizado_en = now()
             where estado = 'en_proceso' and visible_desde <= now() returning 1)
  select count(*)::int from u;
$$;

-- ---------------------------------------------------------------------
-- Reglas operativas por vacante (D6, D7): versionadas e inmutables
-- El JSON se valida con Zod en la aplicación (src/domains/vacantes).
-- ---------------------------------------------------------------------
create table config.vacantes_reglas (
  vacante_id uuid not null references shared.vacantes(id),
  version int not null check (version > 0),
  cliente_id uuid not null references shared.clientes(id),
  reglas jsonb not null,
  creado_por uuid,
  creado_en timestamptz not null default now(),
  primary key (vacante_id, version)
);

create or replace function config.prohibir_mutacion() returns trigger
language plpgsql as $$ begin raise exception 'Las versiones de reglas son inmutables'; end $$;
create trigger vacantes_reglas_inmutables before update or delete on config.vacantes_reglas
  for each row execute function config.prohibir_mutacion();

create table config.vacantes_reglas_auditoria (
  id bigint generated always as identity primary key,
  vacante_id uuid not null,
  cliente_id uuid not null,
  version int not null,
  usuario_id uuid,
  diff jsonb not null,
  creado_en timestamptz not null default now()
);

create or replace function config.reglas_vigentes(p_vacante uuid)
returns table (version int, reglas jsonb) language sql stable security definer set search_path = '' as $$
  select version, reglas from config.vacantes_reglas where vacante_id = p_vacante order by version desc limit 1;
$$;

alter table config.vacantes_reglas enable row level security;
alter table config.vacantes_reglas_auditoria enable row level security;
grant select on config.vacantes_reglas, config.vacantes_reglas_auditoria to authenticated;
create policy reglas_lectura on config.vacantes_reglas for select to authenticated using (shared.puede_ver_vacante(vacante_id));
create policy auditoria_lectura on config.vacantes_reglas_auditoria for select to authenticated using (shared.puede_ver_vacante(vacante_id));

-- service_role (edge functions) accede a todo; RLS no aplica a service_role (bypassrls en Supabase).
grant all on all tables in schema shared, config, captacion, citas, comunicacion, tracking, dashboard, privacidad to service_role;
grant all on all sequences in schema shared, config to service_role;
alter default privileges in schema shared, config, captacion, citas, comunicacion, tracking, dashboard, privacidad grant all on tables to service_role;
alter default privileges in schema shared, config, captacion, citas, comunicacion, tracking, dashboard, privacidad grant all on sequences to service_role;

-- ---------------------------------------------------------------------
-- Consumo del outbox por cursor (grupos de consumidores, al estilo Kafka).
-- Cada dominio suscriptor (comunicacion, tracking, zoho, dashboard…) avanza su propio cursor;
-- no hay despachador central que conozca a todos los dominios.
-- ---------------------------------------------------------------------
create table shared.outbox_consumidores (
  consumidor text primary key,
  ultimo_id bigint not null default 0,
  actualizado_en timestamptz not null default now()
);
alter table shared.outbox_consumidores enable row level security;

-- Devuelve hasta p_n eventos posteriores al cursor (filtrados por tipo) bloqueando el cursor
-- (dos instancias del mismo consumidor no leen lo mismo). Llamar dentro de una transacción
-- y luego shared.avanzar_outbox con el último id procesado.
create or replace function shared.leer_outbox(p_consumidor text, p_tipos text[], p_n int default 100)
returns setof shared.outbox language plpgsql security definer set search_path = '' as $$
declare v_ultimo bigint;
begin
  insert into shared.outbox_consumidores (consumidor) values (p_consumidor) on conflict do nothing;
  select ultimo_id into v_ultimo from shared.outbox_consumidores where consumidor = p_consumidor for update;
  return query select * from shared.outbox where id > v_ultimo and tipo = any (p_tipos) order by id limit p_n;
end $$;

create or replace function shared.avanzar_outbox(p_consumidor text, p_ultimo_id bigint) returns void
language sql security definer set search_path = '' as $$
  update shared.outbox_consumidores set ultimo_id = greatest(ultimo_id, p_ultimo_id), actualizado_en = now()
  where consumidor = p_consumidor;
$$;

-- ---------------------------------------------------------------------
-- Endurecimiento: cola y outbox solo para service_role (edge functions) y funciones
-- security definer de los dominios (que corren como su dueño). Los helpers de RLS
-- (es_admin, puede_ver_vacante, puede_operar_vacante) sí los necesita authenticated.
-- ---------------------------------------------------------------------
revoke execute on function
  shared.publicar_evento(text, jsonb, uuid, text),
  shared.encolar(text, jsonb, text, smallint, uuid, timestamptz, smallint),
  shared.tomar(text, int, int),
  shared.completar(bigint),
  shared.fallar(bigint, text, int),
  shared.recuperar_vencidos(),
  shared.leer_outbox(text, text[], int),
  shared.avanzar_outbox(text, bigint)
from public, anon, authenticated;
grant execute on function
  shared.publicar_evento(text, jsonb, uuid, text),
  shared.encolar(text, jsonb, text, smallint, uuid, timestamptz, smallint),
  shared.tomar(text, int, int),
  shared.completar(bigint),
  shared.fallar(bigint, text, int),
  shared.recuperar_vencidos(),
  shared.leer_outbox(text, text[], int),
  shared.avanzar_outbox(text, bigint)
to service_role;
revoke execute on function shared.es_admin(), shared.puede_ver_vacante(uuid), shared.puede_operar_vacante(uuid) from public, anon;
grant execute on function shared.es_admin(), shared.puede_ver_vacante(uuid), shared.puede_operar_vacante(uuid) to authenticated, service_role;
revoke execute on function config.reglas_vigentes(uuid) from public, anon;
grant execute on function config.reglas_vigentes(uuid) to authenticated, service_role;
