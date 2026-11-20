-- =====================================================================
-- Cierre backend · TRK-07 "lugar de acceso": respaldo por IP cuando el CDN no manda ciudad.
-- La ingesta sigue usando headers del CDN (síncrono). Para los eventos sin dato, el worker de tracking
-- resuelve de forma asíncrona con GeoIpPort (GEOIP_URL) y escribe SOLO ciudad/región/país.
-- La IP sigue la política R5 (completa ≤ 7 días, luego /24 o /48).
-- =====================================================================
alter table tracking.eventos add column geo_intentado boolean not null default false;
create index eventos_sin_geo on tracking.eventos (creado_en)
  where geo_intentado = false and ciudad is null and region is null and pais is null and ip is not null;

-- Candidatos: con consentimiento, IP completa, sin lugar ni intento previo, últimos 7 días.
create or replace function tracking.eventos_sin_geo(p_n int default 100)
returns table (event_id uuid, creado_en timestamptz, ip text)
language sql stable security definer set search_path = '' as $$
  select e.event_id, e.creado_en, host(e.ip)
  from tracking.eventos e
  where e.geo_intentado = false and e.ciudad is null and e.region is null and e.pais is null
    and e.ip is not null and e.consentimiento
    and masklen(e.ip) = case family(e.ip) when 4 then 32 else 128 end
    and e.creado_en > now() - interval '7 days'
  order by e.creado_en
  limit greatest(1, least(p_n, 1000));
$$;

-- Escritura en lote: [{event_id, creado_en, ciudad, region, pais}]. Nunca pisa un lugar ya presente (CDN).
create or replace function tracking.fijar_geo(p_items jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  with i as (
    select (x ->> 'event_id')::uuid as event_id, (x ->> 'creado_en')::timestamptz as creado_en,
           left(nullif(x ->> 'ciudad', ''), 100) as ciudad, left(nullif(x ->> 'region', ''), 100) as region,
           case when x ->> 'pais' ~ '^[A-Za-z]{2}$' then upper(x ->> 'pais') end as pais
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  ), u as (
    update tracking.eventos e
    set geo_intentado = true,
        ciudad = case when e.ciudad is null and e.region is null and e.pais is null then i.ciudad else e.ciudad end,
        region = case when e.ciudad is null and e.region is null and e.pais is null then i.region else e.region end,
        pais   = case when e.ciudad is null and e.region is null and e.pais is null then i.pais else e.pais end
    from i where e.event_id = i.event_id and e.creado_en = i.creado_en
    returning 1)
  select count(*)::int into v_n from u;
  return v_n;
end $$;

revoke execute on function tracking.eventos_sin_geo(int), tracking.fijar_geo(jsonb) from public, anon, authenticated;
grant execute on function tracking.eventos_sin_geo(int), tracking.fijar_geo(jsonb) to service_role;
