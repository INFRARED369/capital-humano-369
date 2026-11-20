-- =====================================================================
-- Citas · Zoho: privacidad (PRV-02) y retención (evento en Zoho hasta cita + 30 días).
-- Nombres con prefijo zoho_ para no chocar con citas.suprimir_lead / citas.retencion_aplicar
-- del dominio citas, que deben invocarlas (ver docs/bitacora/zoho.md).
-- El borrado en Zoho lo hace el zoho-sync-worker: aquí se marca el estado deseado
-- (vigente = false) y se encola el trabajo en `zoho-sync`.
-- =====================================================================

-- Supresión del lead (ARCO / revocación): anonimiza y encola el borrado de sus eventos. Idempotente.
create or replace function citas.zoho_suprimir_lead(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_total int := 0;
  v_encolados int := 0;
begin
  for r in
    update citas.zoho_eventos z set
      nombre_pila = null,
      folio = '-',  -- el folio también es cuasi-identificador; el borrado en Zoho usa zoho_event_uid
      vigente = false,
      estado_sync = case
        when z.estado_sync in ('borrado', 'reemplazado') then z.estado_sync
        when z.zoho_calendar_uid is not null then 'pendiente'
        else 'borrado' end,
      actualizado_en = now()
    where z.lead_id = p_lead
    returning z.cita_id, z.cliente_id, z.estado_sync
  loop
    v_total := v_total + 1;
    if r.estado_sync = 'pendiente' then
      perform shared.encolar('zoho-sync', jsonb_build_object('cita_id', r.cita_id), 'suprimir:' || r.cita_id::text,
                             5::smallint, r.cliente_id, now(), 3::smallint);
      v_encolados := v_encolados + 1;
    end if;
  end loop;
  return jsonb_build_object('zoho_eventos', v_total, 'borrados_encolados', v_encolados);
end $$;

-- Retención: evento en Zoho hasta la fecha de la cita + 30 días. Idempotente y en lotes.
--  1) purga filas ya borradas en Zoho y anonimizadas (sin PII, solo ids);
--  2) anonimiza y marca para borrado las citas vencidas (+30 d) y encola el borrado en Zoho.
create or replace function citas.zoho_retencion_aplicar(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_purgados int;
  v_vencidas int := 0;
  v_encolados int := 0;
  v_limite constant int := 1000;
begin
  with p as (
    delete from citas.zoho_eventos z where z.cita_id in (
      select cita_id from citas.zoho_eventos
      where fin + interval '30 days' <= p_ahora and not vigente and nombre_pila is null
        and estado_sync in ('borrado', 'reemplazado')
      limit v_limite)
    returning 1)
  select count(*) into v_purgados from p;

  for r in
    update citas.zoho_eventos z set
      nombre_pila = null,
      folio = '-',  -- el folio también es cuasi-identificador; el borrado en Zoho usa zoho_event_uid
      vigente = false,
      estado_sync = case
        when z.estado_sync in ('borrado', 'reemplazado') then z.estado_sync
        when z.zoho_calendar_uid is not null then 'pendiente'
        else 'borrado' end,
      actualizado_en = now()
    where z.cita_id in (
      select cita_id from citas.zoho_eventos
      where fin + interval '30 days' <= p_ahora and (vigente or nombre_pila is not null)
      limit v_limite)
    returning z.cita_id, z.cliente_id, z.estado_sync
  loop
    v_vencidas := v_vencidas + 1;
    if r.estado_sync = 'pendiente' then
      perform shared.encolar('zoho-sync', jsonb_build_object('cita_id', r.cita_id), 'retencion:' || r.cita_id::text,
                             5::smallint, r.cliente_id, now(), 3::smallint);
      v_encolados := v_encolados + 1;
    end if;
  end loop;

  return jsonb_build_object('zoho_evento_cita_30d', v_vencidas, 'borrados_encolados', v_encolados, 'purgados', v_purgados);
end $$;

revoke all on function citas.zoho_suprimir_lead(uuid) from public, anon, authenticated;
revoke all on function citas.zoho_retencion_aplicar(timestamptz) from public, anon, authenticated;
grant execute on function citas.zoho_suprimir_lead(uuid) to service_role;
grant execute on function citas.zoho_retencion_aplicar(timestamptz) to service_role;
