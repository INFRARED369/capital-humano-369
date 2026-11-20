-- =====================================================================
-- Cierre backend · shared.fallar_definitivo (Zoho §Pendientes 4, Comunicación contrato 8).
-- Un error permanente (4xx de validación, payload fuera de contrato) no debe gastar reintentos
-- con backoff: va directo a shared.dead_letter. Idempotente; solo service_role.
-- Devuelve el estado final del item: 'dead_letter' | 'completado' | 'cancelado' (o null si no existe).
-- =====================================================================
create or replace function shared.fallar_definitivo(p_id bigint, p_error text)
returns text language plpgsql security definer set search_path = '' as $$
declare r shared.cola;
begin
  select * into r from shared.cola where id = p_id for update;
  if not found then return null; end if;
  if r.estado in ('dead_letter', 'completado', 'cancelado') then return r.estado; end if;
  update shared.cola set estado = 'dead_letter', ultimo_error = left(p_error, 500), actualizado_en = now() where id = p_id;
  insert into shared.dead_letter (cola_id, cola, payload, cliente_id, motivo)
  values (r.id, r.cola, r.payload, r.cliente_id, left(coalesce(p_error, 'permanente'), 500));
  return 'dead_letter';
end $$;

revoke execute on function shared.fallar_definitivo(bigint, text) from public, anon, authenticated;
grant execute on function shared.fallar_definitivo(bigint, text) to service_role;
