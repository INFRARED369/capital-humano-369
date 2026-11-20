-- =====================================================================
-- Tracking · Privacidad (contrato del dominio transversal privacidad, CONTRATOS §8)
-- * tracking.retencion_aplicar(p_ahora): R4 (crudos > 90 días → conteos anónimos y borrado),
--   R5 (IP > 7 días → /24 IPv4, /48 IPv6), vínculos lead↔visitante > 90 días, particiones futuras
--   y borrado de particiones mensuales vacías y vencidas. Idempotente y en lotes.
-- * tracking.suprimir_lead(p_lead): borra los crudos del lead y de su visitante (los suma antes a
--   los conteos anónimos para que el agregado no cambie) y el vínculo. Idempotente.
-- =====================================================================

-- Suma a agregados_diarios y borra de eventos (y de eventos_ids) los crudos indicados por llave.
create or replace function tracking.agregar_y_borrar(p_llaves jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_n bigint;
begin
  with llaves as (
    select (x ->> 'event_id')::uuid as event_id, (x ->> 'creado_en')::timestamptz as creado_en
    from jsonb_array_elements(p_llaves) x
  ), borrados as (
    delete from tracking.eventos e using llaves l
    where e.event_id = l.event_id and e.creado_en = l.creado_en
    returning e.*
  ), agregados as (
    insert into tracking.agregados_diarios as a (dia, vacante_id, cliente_id, origen, utm_source, utm_campaign, nombre, consentimiento, n)
    select tracking.dia_local(b.creado_en), b.vacante_id, b.cliente_id, b.origen, b.utm_source, b.utm_campaign, b.nombre, b.consentimiento, count(*)
    from borrados b
    group by 1, 2, 3, 4, 5, 6, 7, 8
    on conflict on constraint agregados_diarios_llave do update set n = a.n + excluded.n
    returning 1
  ), ids as (
    delete from tracking.eventos_ids i using borrados b where i.event_id = b.event_id returning 1
  )
  select count(*) into v_n from borrados;
  return v_n;
end $$;

create or replace function tracking.retencion_aplicar(p_ahora timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lote jsonb;
  v_n bigint;
  v_agregados bigint := 0;
  v_ips bigint;
  v_leads bigint;
  v_particiones int;
  v_borradas int := 0;
  v_tiene boolean;
  r record;
begin
  -- R4 · eventos crudos > 90 días, en lotes de 5 000
  loop
    select coalesce(jsonb_agg(jsonb_build_object('event_id', event_id, 'creado_en', creado_en)), '[]'::jsonb) into v_lote
    from (select event_id, creado_en from tracking.eventos where creado_en < p_ahora - interval '90 days' order by creado_en limit 5000) s;
    exit when jsonb_array_length(v_lote) = 0;
    v_n := tracking.agregar_y_borrar(v_lote);
    v_agregados := v_agregados + v_n;
  end loop;

  -- R5 · IP completa > 7 días → IPv4 /24, IPv6 /48 (solo queda la ciudad)
  with u as (
    update tracking.eventos set ip = network(set_masklen(ip, case when family(ip) = 4 then 24 else 48 end))::inet
    where creado_en < p_ahora - interval '7 days' and ip is not null
      and masklen(ip) = case when family(ip) = 4 then 32 else 128 end
    returning 1
  ) select count(*) into v_ips from u;

  -- Vínculo lead ↔ visitante > 90 días (mismo plazo que los eventos de navegación)
  with d as (delete from tracking.leads where creado_en < p_ahora - interval '90 days' returning 1)
  select count(*) into v_leads from d;

  -- Ventana de particiones hacia adelante y borrado de meses vencidos y vacíos
  v_particiones := tracking.crear_particiones(date_trunc('month', p_ahora)::date, 4);
  for r in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace
    where i.inhparent = 'tracking.eventos'::regclass and n.nspname = 'tracking' and c.relname ~ '^eventos_\d{4}_\d{2}$'
      and (to_date(substr(c.relname, 9), 'YYYY_MM') + interval '1 month') < p_ahora - interval '90 days'
  loop
    execute format('select exists (select 1 from tracking.%I)', r.relname) into strict v_tiene;
    if not v_tiene then
      execute format('drop table tracking.%I', r.relname);
      v_borradas := v_borradas + 1;
    end if;
  end loop;

  return jsonb_build_object('R4_eventos_agregados', v_agregados, 'R5_ips_truncadas', v_ips, 'leads_desvinculados', v_leads,
                            'particiones_creadas', v_particiones, 'particiones_borradas', v_borradas);
end $$;

create or replace function tracking.suprimir_lead(p_lead uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_visitor uuid;
  v_lote jsonb;
  v_eventos bigint;
  v_leads bigint;
begin
  select visitor_id into v_visitor from tracking.leads where lead_id = p_lead;
  select coalesce(jsonb_agg(jsonb_build_object('event_id', event_id, 'creado_en', creado_en)), '[]'::jsonb) into v_lote
  from tracking.eventos where lead_id = p_lead or (v_visitor is not null and visitor_id = v_visitor);
  v_eventos := tracking.agregar_y_borrar(v_lote);
  with d as (delete from tracking.leads where lead_id = p_lead returning 1) select count(*) into v_leads from d;
  return jsonb_build_object('eventos', v_eventos, 'leads', v_leads);
end $$;

revoke all on function tracking.agregar_y_borrar(jsonb), tracking.retencion_aplicar(timestamptz), tracking.suprimir_lead(uuid) from public;
grant execute on function tracking.agregar_y_borrar(jsonb), tracking.retencion_aplicar(timestamptz), tracking.suprimir_lead(uuid) to service_role;
