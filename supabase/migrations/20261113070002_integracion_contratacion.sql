-- =====================================================================
-- Integración (orquestador) · LeadContratado en privacidad + dashboard en el orquestador de retención.
--  1. Ciclo de vida (Política §2, "Lead contratado: hasta la entrega al cliente (máx. 30 días)
--     → bloqueo de 30 días → anonimización"): etapas `contratado` y `entregado`, alimentadas por
--     LeadContratado (dashboard.registrar_contratacion). Paridad con src/domains/privacidad/domain/ciclo-vida.ts.
--       contratado: referencia = contratación; activo 30 días; +30 de bloqueo.
--       entregado:  referencia = least(entrega, contratación + 30 días); activo 0 (bloqueo inmediato); +30.
--  2. dashboard.suprimir_lead / dashboard.retencion_aplicar entran a las listas blancas y bucles del
--     orquestador (igual que shared), con una sola fuente: privacidad.dominios() (paridad con
--     DOMINIOS_RETENCION de TS).
-- Va después de 20261113070001 (que ya agregó shared).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Etapas nuevas
-- ---------------------------------------------------------------------
alter table privacidad.ciclo_vida drop constraint if exists ciclo_vida_etapa_check;
alter table privacidad.ciclo_vida add constraint ciclo_vida_etapa_check check (etapa in
  ('sin_verificar', 'verificado', 'cita_confirmada', 'cita_cancelada', 'no_asistio', 'asistio', 'contratado', 'entregado'));

create or replace function privacidad.plazos_ciclo(p_etapa text, p_ref timestamptz,
  out fin_activo timestamptz, out fin_bloqueo timestamptz, out accion text)
language sql immutable set search_path = '' as $$
  select p_ref + a, p_ref + a + b, x
  from (values
    ('sin_verificar',   interval '48 hours', interval '0',       'suprimir'),
    ('verificado',      interval '30 days',  interval '30 days', 'anonimizar'),
    ('cita_confirmada', interval '30 days',  interval '30 days', 'anonimizar'),
    ('cita_cancelada',  interval '30 days',  interval '30 days', 'anonimizar'),
    ('no_asistio',      interval '30 days',  interval '30 days', 'anonimizar'),
    ('asistio',         interval '90 days',  interval '30 days', 'anonimizar'),
    ('contratado',      interval '30 days',  interval '30 days', 'anonimizar'),
    ('entregado',       interval '0',        interval '30 days', 'anonimizar')
  ) t(etapa, a, b, x)
  where t.etapa = p_etapa
$$;

-- ---------------------------------------------------------------------
-- 2) Una sola lista de dominios (orden de la política; el kernel shared al final)
-- ---------------------------------------------------------------------
create or replace function privacidad.dominios() returns text[]
language sql immutable set search_path = '' as $$
  select array['captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'shared']
$$;

create or replace function privacidad.llamar_lead(p_fn text, p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_fn not in ('captacion.suprimir_lead', 'captacion.anonimizar_lead', 'citas.suprimir_lead', 'comunicacion.suprimir_lead',
                  'tracking.suprimir_lead', 'dashboard.suprimir_lead', 'shared.suprimir_lead') then
    raise exception 'función no permitida' using errcode = '22023';
  end if;
  if to_regprocedure(p_fn || '(uuid)') is null then
    return jsonb_build_object('faltante', p_fn);
  end if;
  execute format('select %s($1)', p_fn) into v using p_lead;
  return jsonb_build_object('conteos', coalesce(v, '{}'::jsonb));
end $$;

-- Orden: citas (cancela → zoho) → comunicación → tracking → dashboard (desliga contrataciones) → captación → kernel.
create or replace function privacidad.suprimir_en_dominios(p_lead uuid, p_incluir_captacion boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_fn text;
  v jsonb;
  v_conteos jsonb := '{}'::jsonb;
  v_faltantes text[] := '{}'::text[];
begin
  foreach v_fn in array array['citas.suprimir_lead', 'comunicacion.suprimir_lead', 'tracking.suprimir_lead', 'dashboard.suprimir_lead',
                              'captacion.suprimir_lead', 'shared.suprimir_lead'] loop
    continue when v_fn = 'captacion.suprimir_lead' and not p_incluir_captacion;
    v := privacidad.llamar_lead(v_fn, p_lead);
    if v ? 'faltante' then
      v_faltantes := v_faltantes || v_fn;
    else
      v_conteos := jsonb_set(v_conteos, array[split_part(v_fn, '.', 1)], privacidad.sumar_conteos('{}'::jsonb, v -> 'conteos'));
    end if;
  end loop;
  return jsonb_build_object('conteos', v_conteos, 'faltantes', to_jsonb(v_faltantes));
end $$;

-- ---------------------------------------------------------------------
-- 3) Consumidor del outbox: + LeadContratado
-- ---------------------------------------------------------------------
create or replace function privacidad.procesar_outbox(p_ahora timestamptz, p_lote int default 1000, p_max_lotes int default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e record;
  c record;
  v_lead uuid;
  v_etapa text;
  v_ref timestamptz;
  v_cita uuid;
  v_ultimo bigint;
  v_n int;
  v_eventos int := 0;
  v_suprimidos int := 0;
  v_saltados int := 0;
  v_tiene_cita boolean;
  v_entrega timestamptz;
begin
  for i in 1 .. p_max_lotes loop
    v_n := 0;
    v_ultimo := null;
    for e in
      select * from shared.leer_outbox('privacidad', array['LeadCreado', 'WhatsAppVerificado', 'CitaConfirmada', 'CitaReprogramada',
        'CitaCancelada', 'AsistenciaRegistrada', 'LeadContratado', 'LeadSuprimido'], p_lote)
    loop
      v_n := v_n + 1;
      v_ultimo := e.id;
      v_lead := nullif(e.payload ->> 'lead_id', '')::uuid;
      if v_lead is null or (e.payload ->> 'vacante_id') is null then
        v_saltados := v_saltados + 1;
        continue;
      end if;

      if e.tipo = 'LeadSuprimido' then
        delete from privacidad.ciclo_vida where lead_id = v_lead;
        insert into privacidad.barridos (lead_id, cliente_id, repetir_hasta) values (v_lead, e.cliente_id, p_ahora + interval '3 days')
        on conflict (lead_id) do update set repetir_hasta = greatest(privacidad.barridos.repetir_hasta, excluded.repetir_hasta);
        v_suprimidos := v_suprimidos + 1;
        continue;
      end if;
      -- Un lead suprimido no revive por eventos tardíos.
      if exists (select 1 from privacidad.barridos b where b.lead_id = v_lead) then
        v_saltados := v_saltados + 1;
        continue;
      end if;

      select * into c from privacidad.ciclo_vida where lead_id = v_lead for update;
      v_tiene_cita := found and c.etapa in ('cita_confirmada', 'cita_cancelada', 'no_asistio', 'asistio', 'contratado', 'entregado');
      v_etapa := null;
      v_cita := case when found then c.cita_id end;
      v_ref := case when found then c.referencia end;

      -- La contratación es la etapa final: los eventos de cita tardíos no la deshacen.
      if found and c.etapa in ('contratado', 'entregado') and e.tipo <> 'LeadContratado' then
        continue;
      end if;

      case e.tipo
        when 'LeadCreado' then
          if c.lead_id is null then v_etapa := 'sin_verificar'; v_ref := e.creado_en; end if;
        when 'WhatsAppVerificado' then
          if c.lead_id is null or c.etapa = 'sin_verificar' then v_etapa := 'verificado'; v_ref := e.creado_en; end if;
        when 'CitaConfirmada', 'CitaReprogramada' then
          v_etapa := 'cita_confirmada';
          v_cita := (e.payload ->> 'cita_id')::uuid;
          v_ref := coalesce((e.payload ->> 'inicio')::timestamptz, e.creado_en);
        when 'CitaCancelada' then
          if coalesce(e.payload ->> 'motivo', '') <> 'supresion' then
            v_etapa := 'cita_cancelada';
            if not v_tiene_cita then v_ref := e.creado_en; v_cita := (e.payload ->> 'cita_id')::uuid; end if;
          end if;
        when 'AsistenciaRegistrada' then
          v_etapa := case when (e.payload ->> 'asistio')::boolean then 'asistio' else 'no_asistio' end;
          if not v_tiene_cita then v_ref := e.creado_en; v_cita := (e.payload ->> 'cita_id')::uuid; end if;
        when 'LeadContratado' then
          v_cita := coalesce(nullif(e.payload ->> 'cita_id', '')::uuid, v_cita);
          v_entrega := nullif(e.payload ->> 'entregado_en', '')::timestamptz;
          if v_entrega is null then
            -- Contratación (sin entrega): no deshace una entrega ya registrada.
            if not (found and c.etapa = 'entregado') then v_etapa := 'contratado'; v_ref := e.creado_en; end if;
          else
            v_etapa := 'entregado';
            v_ref := case when found and c.etapa = 'contratado' then least(v_entrega, c.referencia + interval '30 days') else v_entrega end;
          end if;
      end case;

      if v_etapa is null then continue; end if;
      insert into privacidad.ciclo_vida as cv (lead_id, cliente_id, vacante_id, etapa, cita_id, referencia, fin_activo, fin_bloqueo, actualizado_en)
      select v_lead, e.cliente_id, (e.payload ->> 'vacante_id')::uuid, v_etapa, v_cita, v_ref, p.fin_activo, p.fin_bloqueo, p_ahora
      from privacidad.plazos_ciclo(v_etapa, v_ref) p
      on conflict (lead_id) do update set etapa = excluded.etapa, cita_id = excluded.cita_id, referencia = excluded.referencia,
        fin_activo = excluded.fin_activo, fin_bloqueo = excluded.fin_bloqueo, actualizado_en = excluded.actualizado_en,
        bloqueado_en = case when excluded.fin_activo > p_ahora then null else cv.bloqueado_en end;
      v_eventos := v_eventos + 1;
    end loop;

    if v_ultimo is not null then perform shared.avanzar_outbox('privacidad', v_ultimo); end if;
    exit when v_n < p_lote;
  end loop;
  return jsonb_build_object('outbox_eventos', v_eventos, 'outbox_suprimidos', v_suprimidos, 'outbox_saltados', v_saltados);
end $$;

-- ---------------------------------------------------------------------
-- 4) Anonimización al fin del bloqueo: + dashboard.suprimir_lead (desliga la contratación)
-- ---------------------------------------------------------------------
create or replace function privacidad.aplicar_ciclo_vida(p_ahora timestamptz, p_lote int default 1000) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v jsonb;
  v_fn text;
  v_bloqueados int;
  v_anon int := 0;
  v_atrasados int;
  v_conteos jsonb := '{}'::jsonb;
  v_faltantes text[] := '{}'::text[];
  v_ok boolean;
begin
  with b as (
    update privacidad.ciclo_vida c set bloqueado_en = p_ahora
    where c.lead_id in (select lead_id from privacidad.ciclo_vida
                        where bloqueado_en is null and etapa <> 'sin_verificar' and fin_activo <= p_ahora limit p_lote)
    returning 1)
  select count(*) into v_bloqueados from b;

  for r in
    select lead_id from privacidad.ciclo_vida
    where etapa <> 'sin_verificar' and fin_bloqueo <= p_ahora
    order by fin_bloqueo limit p_lote for update skip locked
  loop
    v_ok := true;
    foreach v_fn in array array['captacion.anonimizar_lead', 'comunicacion.suprimir_lead', 'tracking.suprimir_lead',
                                'dashboard.suprimir_lead', 'shared.suprimir_lead'] loop
      v := privacidad.llamar_lead(v_fn, r.lead_id);
      if v ? 'faltante' then
        if not v_fn = any (v_faltantes) then v_faltantes := v_faltantes || v_fn; end if;
        if v_fn = 'captacion.anonimizar_lead' then v_ok := false; end if;
      else
        v_conteos := privacidad.sumar_conteos(v_conteos, jsonb_build_object(split_part(v_fn, '.', 1), v -> 'conteos'));
      end if;
    end loop;
    if v_ok then
      delete from privacidad.ciclo_vida where lead_id = r.lead_id;
      v_anon := v_anon + 1;
    end if;
  end loop;

  select count(*) into v_atrasados from privacidad.ciclo_vida
  where etapa = 'sin_verificar' and fin_activo + interval '7 days' <= p_ahora;

  return jsonb_build_object('conteos', jsonb_build_object('ciclo_bloqueados', v_bloqueados, 'ciclo_anonimizados', v_anon,
    'ciclo_sin_verificar_atrasados', v_atrasados, 'anonimizacion', v_conteos), 'faltantes', to_jsonb(v_faltantes));
end $$;

-- ---------------------------------------------------------------------
-- 5) Retención por dominio y orquestador: lista desde privacidad.dominios()
-- ---------------------------------------------------------------------
create or replace function privacidad.retencion_dominio(p_schema text, p_ahora timestamptz, p_max_lotes int default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_total jsonb := '{}'::jsonb; v_lotes int := 0; v_error text;
begin
  if not p_schema = any (privacidad.dominios()) then
    raise exception 'schema no permitido' using errcode = '22023';
  end if;
  if to_regprocedure(p_schema || '.retencion_aplicar(timestamptz)') is null then
    return jsonb_build_object('faltante', true);
  end if;
  loop
    exit when v_lotes >= greatest(p_max_lotes, 1);
    begin
      execute format('select %I.retencion_aplicar($1)', p_schema) into v using p_ahora;
    exception when others then
      v_error := sqlstate;
      exit;
    end;
    v_lotes := v_lotes + 1;
    v_total := privacidad.sumar_conteos(v_total, v);
    exit when privacidad.total_conteos(privacidad.sumar_conteos('{}'::jsonb, v)) = 0;
  end loop;
  return jsonb_build_object('conteos', v_total, 'lotes', v_lotes) || case when v_error is null then '{}'::jsonb else jsonb_build_object('error', v_error) end;
end $$;

create or replace function privacidad.retencion_diaria(p_ahora timestamptz default now(), p_max_lotes int default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d text;
  v jsonb;
  v_conteos jsonb := '{}'::jsonb;
  v_lotes jsonb := '{}'::jsonb;
  v_errores jsonb := '{}'::jsonb;
  v_faltantes text[] := '{}'::text[];
  v_dominios text[] := '{}'::text[];
  v_reglas text[] := '{}'::text[];
  v_priv jsonb := '{}'::jsonb;
  v_paso text;
  v_id bigint;
  v_orden text[] := privacidad.dominios();
begin
  if not pg_try_advisory_xact_lock(hashtext('privacidad.retencion_diaria')) then
    return jsonb_build_object('omitida', true);
  end if;

  foreach d in array v_orden loop
    v := privacidad.retencion_dominio(d, p_ahora, p_max_lotes);
    if v ? 'faltante' then
      v_faltantes := v_faltantes || d;
      continue;
    end if;
    v_lotes := v_lotes || jsonb_build_object(d, (v ->> 'lotes')::int);
    v_conteos := v_conteos || jsonb_build_object(d, v -> 'conteos');
    if v ? 'error' then
      v_errores := v_errores || jsonb_build_object(d, v ->> 'error');
    else
      v_dominios := v_dominios || d;
      v_reglas := v_reglas || (d || '.retencion_aplicar');
    end if;
  end loop;

  foreach v_paso in array array['outbox', 'barrido', 'ciclo_vida', 'propio'] loop
    begin
      case v_paso
        when 'outbox' then v := jsonb_build_object('conteos', privacidad.procesar_outbox(p_ahora));
        when 'barrido' then v := privacidad.barrer(p_ahora);
        when 'ciclo_vida' then v := privacidad.aplicar_ciclo_vida(p_ahora);
        when 'propio' then v := jsonb_build_object('conteos', privacidad.retencion_aplicar(p_ahora));
      end case;
      v_priv := privacidad.sumar_conteos(v_priv, v -> 'conteos');
      v_faltantes := v_faltantes || coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v -> 'faltantes', '[]'::jsonb)) x
                                              where not x = any (v_faltantes)), '{}');
      v_reglas := v_reglas || ('privacidad.' || case v_paso when 'propio' then 'retencion_aplicar' else v_paso end);
    exception when others then
      v_errores := v_errores || jsonb_build_object('privacidad_' || v_paso, sqlstate);
    end;
  end loop;
  v_conteos := v_conteos || jsonb_build_object('privacidad', v_priv);
  v_faltantes := array(select distinct x from unnest(v_faltantes) x order by 1);
  v_faltantes := array(select x from unnest(v_orden) x where x = any (v_faltantes))
              || array(select x from unnest(v_faltantes) x where x <> all (v_orden));

  insert into privacidad.registro_supresiones (tipo, ejecutado_en, reglas, conteos, faltantes, errores)
  values ('retencion', p_ahora, v_reglas, v_conteos, v_faltantes, v_errores)
  returning id into v_id;

  return jsonb_build_object('registro_id', v_id, 'dominios', to_jsonb(v_dominios), 'faltantes', to_jsonb(v_faltantes),
    'errores', v_errores, 'lotes', v_lotes, 'conteos', v_conteos,
    'total', privacidad.total_conteos(v_conteos) - coalesce((v_conteos #>> '{tracking,particiones_creadas}')::numeric, 0));
end $$;

-- Permisos (igual que la migración de privacidad): solo service_role, salvo api_lead_bloqueado.
revoke all on all functions in schema privacidad from public, anon, authenticated;
grant execute on all functions in schema privacidad to service_role;
grant execute on function privacidad.api_lead_bloqueado(uuid) to authenticated;
