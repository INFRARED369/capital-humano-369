-- =====================================================================
-- Integración (orquestador): cierra las brechas de privacidad entre dominios
-- detectadas por el dominio privacidad (docs/bitacora/privacidad.md).
-- Va después de 2026111306* porque usa privacidad.api_lead_bloqueado.
-- =====================================================================

-- 1) Captación · ARCO por teléfono: búsqueda del lead por HMAC (nunca en claro).
create or replace function captacion.api_leads_por_telefono_hmac(p_hmac text)
returns table (lead_id uuid, cliente_id uuid, vacante_id uuid)
language sql stable security definer set search_path = '' as $$
  select l.id, l.cliente_id, l.vacante_id from captacion.leads l where l.telefono_hmac = p_hmac;
$$;
revoke execute on function captacion.api_leads_por_telefono_hmac(text) from public, anon, authenticated;
grant execute on function captacion.api_leads_por_telefono_hmac(text) to service_role;

-- 2) Captación · durante el bloqueo de 30 días solo admin ve la PII del lead.
drop policy if exists leads_lectura_panel on captacion.leads;
create policy leads_lectura_panel on captacion.leads for select to authenticated
  using (shared.puede_ver_vacante(vacante_id) and (shared.es_admin() or not privacidad.api_lead_bloqueado(id)));
grant execute on function privacidad.api_lead_bloqueado(uuid) to authenticated;

-- 3) Plataforma · el outbox no conserva datos personales.
-- Claves de payload con dato personal o cuasi-identificador que se eliminan al suprimir.
create or replace function shared.suprimir_lead(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_outbox int; v_dl int;
begin
  with u as (
    update shared.outbox set payload = payload - 'nombre_pila' - 'folio' - 'visitor_id'
    where payload ->> 'lead_id' = p_lead::text and (payload ? 'nombre_pila' or payload ? 'folio' or payload ? 'visitor_id')
    returning 1)
  select count(*)::int into v_outbox from u;
  with d as (delete from shared.dead_letter where payload ->> 'lead_id' = p_lead::text returning 1)
  select count(*)::int into v_dl from d;
  return jsonb_build_object('outbox_depurados', v_outbox, 'dead_letter_borrados', v_dl);
end $$;

-- Retención del kernel: borra eventos del outbox ya leídos por TODOS los consumidores y con
-- más de 30 días; quita PII de cualquier evento de más de 30 días aunque algún consumidor
-- siga atrasado; purga cola terminada y dead letters de más de 30 días. En lotes.
create or replace function shared.retencion_aplicar(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_min bigint; v_borrados int; v_depurados int; v_cola int; v_dl int; v_limite timestamptz := p_ahora - interval '30 days';
begin
  select coalesce(min(ultimo_id), 0) into v_min from shared.outbox_consumidores;
  with d as (
    delete from shared.outbox where id in (
      select id from shared.outbox where id <= v_min and creado_en < v_limite order by id limit 5000)
    returning 1)
  select count(*)::int into v_borrados from d;
  with u as (
    update shared.outbox set payload = payload - 'nombre_pila' - 'folio' - 'visitor_id'
    where id in (select id from shared.outbox where creado_en < v_limite
                 and (payload ? 'nombre_pila' or payload ? 'folio' or payload ? 'visitor_id') limit 5000)
    returning 1)
  select count(*)::int into v_depurados from u;
  with d as (
    delete from shared.cola where id in (
      select id from shared.cola where estado in ('completado', 'cancelado', 'dead_letter') and actualizado_en < v_limite limit 5000)
    returning 1)
  select count(*)::int into v_cola from d;
  with d as (
    delete from shared.dead_letter where id in (select id from shared.dead_letter where creado_en < v_limite limit 5000)
    returning 1)
  select count(*)::int into v_dl from d;
  return jsonb_build_object('outbox_borrados', v_borrados, 'outbox_depurados', v_depurados, 'cola_purgada', v_cola, 'dead_letter_purgados', v_dl);
end $$;

revoke execute on function shared.suprimir_lead(uuid), shared.retencion_aplicar(timestamptz) from public, anon, authenticated;
grant execute on function shared.suprimir_lead(uuid), shared.retencion_aplicar(timestamptz) to service_role;
