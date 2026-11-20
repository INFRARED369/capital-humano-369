-- =====================================================================
-- Dashboard (dueño: dashboard/panel) · DSH-01, DSH-02, DSH-03, DSH-06, S1, F6.3
--
-- * Solo combina las vistas públicas `api_*` de otros dominios (regla 1 de CONTRATOS):
--     tracking.api_funnel_diario · citas.api_ocupacion_diaria · comunicacion.api_costos · comunicacion.api_fallos
-- * Vistas MATERIALIZADAS (refresco programado cada 10 min con pg_cron + dashboard.refrescar()).
--   Se calculan como su dueño (postgres) sobre todos los tenants; por eso NO se exponen:
--   el panel lee `dashboard.api_*`, vistas security_barrier que filtran con shared.puede_ver_vacante
--   (S1/DSH-06: reclutador solo sus vacantes, cliente solo la suya, admin todo).
-- * Semántica del día: funnel = día del evento; ocupación = día local de la cita; costos = día del intento.
--   El cupo es el de las reglas VIGENTES (citas.api_ocupacion_diaria), también para días pasados.
-- =====================================================================

create materialized view dashboard.mv_funnel as
select
  f.dia,
  coalesce(f.vacante_id, '00000000-0000-0000-0000-000000000000'::uuid) as vacante_id,
  f.cliente_id,
  coalesce(f.campana, '') as campana,
  f.origen,
  f.evento,
  sum(f.eventos)::bigint as eventos,
  now() as refrescado_en
from tracking.api_funnel_diario f
group by 1, 2, 3, 4, 5, 6
with data;
create unique index mv_funnel_llave on dashboard.mv_funnel (dia, vacante_id, cliente_id, campana, origen, evento);

create materialized view dashboard.mv_kpis_diarios as
with f as (
  select dia, vacante_id, cliente_id,
    coalesce(sum(eventos) filter (where evento = 'PageView'), 0) as visitas,
    coalesce(sum(eventos) filter (where evento = 'FormSubmitted'), 0) as formularios,
    coalesce(sum(eventos) filter (where evento = 'LeadCreado'), 0) as leads,
    coalesce(sum(eventos) filter (where evento = 'WhatsAppVerificado'), 0) as verificados,
    coalesce(sum(eventos) filter (where evento = 'CitaConfirmada'), 0) as citas_confirmadas
  from tracking.api_funnel_diario
  where vacante_id is not null
  group by 1, 2, 3
), o as (
  select dia, vacante_id, cliente_id, sum(retenidas) as retenidas, sum(confirmadas) as confirmadas,
    sum(asistio) as asistio, sum(no_asistio) as no_asistio, max(cupo) as cupo
  from citas.api_ocupacion_diaria
  group by 1, 2, 3
), c as (
  select dia, vacante_id, cliente_id, sum(costo_mxn) as costo_mxn,
    coalesce(sum(costo_mxn) filter (where canal = 'whatsapp'), 0) as costo_whatsapp_mxn,
    sum(intentos) as intentos, sum(exitosos) as exitosos
  from comunicacion.api_costos
  group by 1, 2, 3
), fl as (
  select dia, vacante_id, cliente_id, sum(fallidos) as fallidos
  from comunicacion.api_fallos
  group by 1, 2, 3
), llaves as (
  select dia, vacante_id, cliente_id from f
  union select dia, vacante_id, cliente_id from o
  union select dia, vacante_id, cliente_id from c
  union select dia, vacante_id, cliente_id from fl
)
select
  k.dia, k.vacante_id, k.cliente_id,
  coalesce(f.visitas, 0)::int as visitas,
  coalesce(f.formularios, 0)::int as formularios,
  coalesce(f.leads, 0)::int as leads,
  coalesce(f.verificados, 0)::int as verificados,
  coalesce(f.citas_confirmadas, 0)::int as citas_confirmadas,
  coalesce(o.retenidas, 0)::int as retenidas,
  coalesce(o.confirmadas, 0)::int as confirmadas,
  coalesce(o.asistio, 0)::int as asistio,
  coalesce(o.no_asistio, 0)::int as no_asistio,
  o.cupo::int as cupo,
  coalesce(c.costo_mxn, 0)::numeric(14, 4) as costo_mxn,
  coalesce(c.costo_whatsapp_mxn, 0)::numeric(14, 4) as costo_whatsapp_mxn,
  coalesce(c.intentos, 0)::int as intentos,
  coalesce(c.exitosos, 0)::int as exitosos,
  coalesce(fl.fallidos, 0)::int as fallidos,
  now() as refrescado_en
from llaves k
left join f on f.dia = k.dia and f.vacante_id = k.vacante_id and f.cliente_id = k.cliente_id
left join o on o.dia = k.dia and o.vacante_id = k.vacante_id and o.cliente_id = k.cliente_id
left join c on c.dia = k.dia and c.vacante_id = k.vacante_id and c.cliente_id = k.cliente_id
left join fl on fl.dia = k.dia and fl.vacante_id = k.vacante_id and fl.cliente_id = k.cliente_id
with data;
create unique index mv_kpis_diarios_llave on dashboard.mv_kpis_diarios (dia, vacante_id, cliente_id);
create index mv_kpis_diarios_vacante on dashboard.mv_kpis_diarios (vacante_id, dia);

-- ---------------------------------------------------------------------
-- Superficie de lectura del panel (S1). security_barrier: el filtro de permisos se evalúa antes que
-- cualquier predicado del usuario (no hay fuga por funciones con efectos laterales en el WHERE).
-- ---------------------------------------------------------------------
create view dashboard.api_kpis_diarios with (security_barrier = true) as
select dia, vacante_id, cliente_id, visitas, formularios, leads, verificados, citas_confirmadas,
  retenidas, confirmadas, asistio, no_asistio, cupo,
  costo_mxn::float8 as costo_mxn, costo_whatsapp_mxn::float8 as costo_whatsapp_mxn,
  intentos, exitosos, fallidos, refrescado_en
from dashboard.mv_kpis_diarios
where shared.puede_ver_vacante(vacante_id);

create view dashboard.api_funnel with (security_barrier = true) as
select dia, nullif(vacante_id, '00000000-0000-0000-0000-000000000000'::uuid) as vacante_id, cliente_id,
  nullif(campana, '') as campana, origen, evento, eventos::int as eventos, refrescado_en
from dashboard.mv_funnel
-- vacante desconocida (null) → solo admin: puede_ver_vacante(null) = es_admin()
where shared.puede_ver_vacante(nullif(vacante_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Refresco sin bloquear lecturas (CONCURRENTLY usa los índices únicos).
create or replace function dashboard.refrescar() returns timestamptz
language plpgsql security definer set search_path = '' as $$
begin
  refresh materialized view concurrently dashboard.mv_funnel;
  refresh materialized view concurrently dashboard.mv_kpis_diarios;
  return now();
end $$;

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
revoke all on dashboard.mv_funnel, dashboard.mv_kpis_diarios from public, anon, authenticated;
revoke all on dashboard.api_kpis_diarios, dashboard.api_funnel from public, anon, authenticated;
grant select on dashboard.api_kpis_diarios, dashboard.api_funnel to authenticated, service_role;
grant select on dashboard.mv_funnel, dashboard.mv_kpis_diarios to service_role;
revoke all on function dashboard.refrescar() from public, anon, authenticated;
grant execute on function dashboard.refrescar() to service_role;

-- ---------------------------------------------------------------------
-- Refresco programado (pg_cron). Se omite donde no existe (PGlite en pruebas).
-- ---------------------------------------------------------------------
do $dashboard$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'dashboard: pg_cron no disponible; refresco programado omitido (entorno de pruebas)';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.schedule('dashboard-refrescar', '*/10 * * * *', 'select dashboard.refrescar()');
end
$dashboard$;
