-- =====================================================================
-- Cierre backend · Rate limit híbrido de tracking-ingest (NFR-SEG-03 / NFR-ESC-01).
-- Cada isolate cuenta en memoria y suma a la BD en LOTES (cada N eventos o X s), agregando por red /24
-- (llave HMAC, sin IP). Una consulta por lote en lugar de una por evento. Devuelve el total de la ventana.
-- =====================================================================
create or replace function shared.rate_limit_sumar(p_llaves text[], p_incrementos int[], p_ventana_seg int, p_ahora timestamptz default now())
returns table (llave text, conteo int, reinicia_en timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_inicio timestamptz;
begin
  if p_ventana_seg < 1 or cardinality(p_llaves) <> cardinality(p_incrementos) or cardinality(p_llaves) > 5000
     or exists (select 1 from unnest(p_incrementos) i where i is null or i < 1) then
    raise exception 'rate_limit_sumar: llaves e incrementos inválidos';
  end if;
  v_inicio := to_timestamp(floor(extract(epoch from p_ahora) / p_ventana_seg) * p_ventana_seg);
  return query
  insert into shared.rate_limit as r (llave, ventana_inicio, conteo, expira_en)
  select k, v_inicio, sum(i)::int, v_inicio + make_interval(secs => p_ventana_seg)
  from unnest(p_llaves, p_incrementos) as u(k, i) group by k
  on conflict on constraint rate_limit_pkey do update set conteo = r.conteo + excluded.conteo
  returning r.llave, r.conteo, r.expira_en;
end $$;

revoke all on function shared.rate_limit_sumar(text[], int[], int, timestamptz) from public, anon, authenticated;
grant execute on function shared.rate_limit_sumar(text[], int[], int, timestamptz) to service_role;
