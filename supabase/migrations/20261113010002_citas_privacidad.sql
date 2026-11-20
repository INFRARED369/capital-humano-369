-- =====================================================================
-- Citas · privacidad (regla 8 de src/CONTRATOS.md; Política de retención de datos)
--   citas.suprimir_lead(uuid)         ARCO / revocación / supresión de lead sin verificar
--   citas.retencion_aplicar(timestamptz)  cron diario, idempotente y en lotes
-- Anonimizar = lead_id y evaluación a NULL; se conservan vacante, fechas y estado (R7).
-- Si el subdominio zoho define citas.zoho_suprimir_lead / citas.zoho_retencion_aplicar,
-- se invocan aquí y su resultado se agrega bajo la llave "zoho".
-- =====================================================================

create or replace function citas.suprimir_lead(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_can int;
  v_exp int;
  v_anon int;
  v_zoho jsonb;
begin
  if p_lead is null then
    raise exception 'p_lead requerido' using errcode = '22023';
  end if;

  -- Citas futuras confirmadas: se cancelan (Zoho borra el evento y Comunicación cancela recordatorios).
  with s as (
    update citas.citas c set estado = 'cancelada', motivo = 'supresion', cancelada_en = now(), actualizado_en = now()
    where c.lead_id = p_lead and c.estado = 'confirmada' and c.inicio > now()
    returning c.id, c.lead_id, c.vacante_id, c.cliente_id
  )
  select count(shared.publicar_evento('CitaCancelada', jsonb_build_object(
    'cita_id', s.id, 'lead_id', s.lead_id, 'vacante_id', s.vacante_id, 'cliente_id', s.cliente_id, 'motivo', 'supresion'), s.cliente_id))
  into v_can from s;

  -- Retenciones: se liberan.
  with s as (
    update citas.citas c set estado = 'expirada', motivo = 'supresion', actualizado_en = now()
    where c.lead_id = p_lead and c.estado = 'retenida'
    returning c.id, c.lead_id, c.vacante_id, c.cliente_id
  )
  select count(shared.publicar_evento('CitaExpirada', jsonb_build_object(
    'cita_id', s.id, 'lead_id', s.lead_id, 'vacante_id', s.vacante_id, 'cliente_id', s.cliente_id), s.cliente_id))
  into v_exp from s;

  update citas.citas set lead_id = null, evaluacion = null, anonimizada_en = now(), actualizado_en = now()
  where lead_id = p_lead;
  get diagnostics v_anon = row_count;

  if to_regprocedure('citas.zoho_suprimir_lead(uuid)') is not null then
    execute 'select citas.zoho_suprimir_lead($1)' into v_zoho using p_lead;
  end if;

  return jsonb_build_object('canceladas', v_can, 'expiradas', v_exp, 'anonimizadas', v_anon)
    || case when v_zoho is null then '{}'::jsonb else jsonb_build_object('zoho', v_zoho) end;
end $$;

create or replace function citas.retencion_aplicar(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_lote constant int := 1000;
  v_exp int;
  v_48 int;
  v_60 int;
  v_120 int;
  v_zoho jsonb;
begin
  -- Retenciones vencidas: el slot queda libre (C12).
  v_exp := citas.expirar_retenciones(p_ahora, null, v_lote);

  -- Lead sin verificar WhatsApp > 48 h: su cita nunca se confirmó → se anonimiza.
  with s as (
    select c.id from citas.citas c
    where c.lead_id is not null and c.estado = 'expirada' and c.creado_en < p_ahora - interval '48 hours'
    limit v_lote for update skip locked
  ), u as (
    update citas.citas c set lead_id = null, evaluacion = null, anonimizada_en = p_ahora, actualizado_en = p_ahora
    from s where c.id = s.id returning 1
  ) select count(*) into v_48 from u;

  -- Cancelada / no asistió (y reprogramada o confirmada sin registro): cita + 30 días + 30 de bloqueo.
  with s as (
    select c.id from citas.citas c
    where c.lead_id is not null and c.estado in ('cancelada', 'no_asistio', 'reprogramada', 'confirmada')
      and c.inicio < p_ahora - interval '60 days'
    limit v_lote for update skip locked
  ), u as (
    update citas.citas c set lead_id = null, evaluacion = null, anonimizada_en = p_ahora, actualizado_en = p_ahora
    from s where c.id = s.id returning 1
  ) select count(*) into v_60 from u;

  -- Asistió: cita + 90 días + 30 de bloqueo.
  with s as (
    select c.id from citas.citas c
    where c.lead_id is not null and c.estado = 'asistio' and c.inicio < p_ahora - interval '120 days'
    limit v_lote for update skip locked
  ), u as (
    update citas.citas c set lead_id = null, evaluacion = null, anonimizada_en = p_ahora, actualizado_en = p_ahora
    from s where c.id = s.id returning 1
  ) select count(*) into v_120 from u;

  if to_regprocedure('citas.zoho_retencion_aplicar(timestamptz)') is not null then
    execute 'select citas.zoho_retencion_aplicar($1)' into v_zoho using p_ahora;
  end if;

  return jsonb_build_object('retenciones_expiradas', v_exp, 'sin_verificar_48h', v_48,
                            'cancelada_no_asistio_60d', v_60, 'asistio_120d', v_120)
    || case when v_zoho is null then '{}'::jsonb else jsonb_build_object('zoho', v_zoho) end;
end $$;

revoke execute on function citas.suprimir_lead(uuid) from public;
revoke execute on function citas.retencion_aplicar(timestamptz) from public;
grant execute on function citas.suprimir_lead(uuid) to service_role;
grant execute on function citas.retencion_aplicar(timestamptz) to service_role;
