-- =====================================================================
-- Privacidad (dominio transversal; dueño: privacidad) · PRV-01, PRV-02, PRV-03, R1–R8, D12
-- Política de retención de datos (docs/Reglas de Negocio).
--
--  * privacidad.retencion_diaria(ahora)   orquestador del cron diario: llama EN ORDEN y por lotes a
--      <schema>.retencion_aplicar de captacion → citas (+zoho) → comunicacion → tracking (los detecta con
--      to_regprocedure y reporta los faltantes), consume el outbox (ciclo de vida), aplica el bloqueo de
--      30 días y la anonimización, y escribe UNA fila en registro_supresiones (solo conteos).
--  * privacidad.suprimir_lead(lead[, hmac])  ARCO / revocación: supresión en todos los schemas + opt-out.
--  * privacidad.arco_*                     solicitudes ARCO con plazos (20 días hábiles; los calcula TS).
--  * privacidad.api_lead_bloqueado(lead)    para que el panel oculte leads en bloqueo (solo admin los ve).
--
-- Regla 1 de CONTRATOS: este schema NO lee tablas de otros dominios. Cruza solo con sus funciones de
-- privacidad (regla 8), con shared.leer_outbox (regla 2) y con funciones api_ (si existen).
-- =====================================================================

-- El panel (admin) lee solicitudes y registro por RLS; el resto es solo service_role.
grant usage on schema privacidad to authenticated;

-- ---------------------------------------------------------------------
-- Validadores (CHECK): solo conteos, reglas y códigos. Nunca texto libre.
-- ---------------------------------------------------------------------
create or replace function privacidad.solo_conteos(p jsonb, p_prof int default 0) returns boolean
language plpgsql immutable set search_path = '' as $$
declare r record; v numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' or p_prof >= 6 then return false; end if;
  for r in select key, value from jsonb_each(p) loop
    if r.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' then return false; end if;
    if jsonb_typeof(r.value) = 'number' then
      v := (r.value #>> '{}')::numeric;
      if v < 0 or v <> trunc(v) then return false; end if;
    elsif not privacidad.solo_conteos(r.value, p_prof + 1) then
      return false;
    end if;
  end loop;
  return true;
end $$;

create or replace function privacidad.solo_reglas(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(x ~ '^[a-z][a-z0-9_.]{0,79}$'), true) from unnest(p) x
$$;

create or replace function privacidad.solo_codigos(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and coalesce(bool_and(key ~ '^[a-z][a-z0-9_]{0,63}$' and jsonb_typeof(value) = 'string'
    and (value #>> '{}') ~ '^[0-9A-Z]{5}$'), true)
  from jsonb_each(p)
$$;

-- Suma b sobre a. Descarta todo lo que no sea un entero ≥ 0 o un objeto de conteos (sanea lo que
-- devuelvan los dominios: el registro nunca guarda texto aunque un dominio lo devuelva por error).
create or replace function privacidad.sumar_conteos(a jsonb, b jsonb, p_prof int default 0) returns jsonb
language plpgsql stable set search_path = '' as $$
declare r record; v_res jsonb := coalesce(a, '{}'::jsonb); v_act jsonb; v numeric;
begin
  if b is null or jsonb_typeof(b) <> 'object' or p_prof >= 5 then return v_res; end if;
  for r in select key, value from jsonb_each(b) loop
    continue when r.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$';
    v_act := v_res -> r.key;
    if jsonb_typeof(r.value) = 'number' then
      v := (r.value #>> '{}')::numeric;
      continue when v < 0 or v <> trunc(v);
      v_res := jsonb_set(v_res, array[r.key],
        to_jsonb(coalesce(case when jsonb_typeof(v_act) = 'number' then (v_act #>> '{}')::numeric end, 0) + v));
    elsif jsonb_typeof(r.value) = 'object' then
      v_res := jsonb_set(v_res, array[r.key],
        privacidad.sumar_conteos(case when jsonb_typeof(v_act) = 'object' then v_act else '{}'::jsonb end, r.value, p_prof + 1));
    end if;
  end loop;
  return v_res;
end $$;

create or replace function privacidad.total_conteos(p jsonb) returns numeric
language plpgsql immutable set search_path = '' as $$
declare r record; v_total numeric := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 0; end if;
  for r in select value from jsonb_each(p) loop
    if jsonb_typeof(r.value) = 'number' then v_total := v_total + (r.value #>> '{}')::numeric;
    elsif jsonb_typeof(r.value) = 'object' then v_total := v_total + privacidad.total_conteos(r.value);
    end if;
  end loop;
  return v_total;
end $$;

-- ---------------------------------------------------------------------
-- PRV-03 · Registro de supresiones: solo conteos, fechas y reglas aplicadas. 2 años; luego se borra.
-- cliente_id: 369 (responsable del tratamiento) en corridas globales; el del lead si se conoce.
-- ---------------------------------------------------------------------
create table privacidad.registro_supresiones (
  id bigint generated always as identity primary key,
  cliente_id uuid not null default '00000000-0000-0000-0000-000000000369',
  tipo text not null check (tipo in ('retencion', 'arco', 'supresion')),
  ejecutado_en timestamptz not null,
  reglas text[] not null default '{}' check (privacidad.solo_reglas(reglas)),
  conteos jsonb not null default '{}' check (privacidad.solo_conteos(conteos)),
  faltantes text[] not null default '{}' check (privacidad.solo_reglas(faltantes)),
  errores jsonb not null default '{}' check (privacidad.solo_codigos(errores)),
  solicitud_id uuid,
  creado_en timestamptz not null default now()
);
create index registro_supresiones_ejecutado on privacidad.registro_supresiones (ejecutado_en);

-- ---------------------------------------------------------------------
-- Ciclo de vida del lead (Política §1.2): activo → bloqueado (30 días, solo admin) → anonimizado.
-- Se alimenta del outbox (consumidor 'privacidad'); solo ids y fechas. La fila se borra al anonimizar.
-- ---------------------------------------------------------------------
create table privacidad.ciclo_vida (
  lead_id uuid primary key,
  cliente_id uuid not null,
  vacante_id uuid not null,
  etapa text not null check (etapa in ('sin_verificar', 'verificado', 'cita_confirmada', 'cita_cancelada', 'no_asistio', 'asistio')),
  cita_id uuid,
  referencia timestamptz not null,
  fin_activo timestamptz not null,
  fin_bloqueo timestamptz not null,
  bloqueado_en timestamptz,
  actualizado_en timestamptz not null default now(),
  check (fin_bloqueo >= fin_activo)
);
create index ciclo_vida_por_bloquear on privacidad.ciclo_vida (fin_activo) where bloqueado_en is null;
create index ciclo_vida_por_anonimizar on privacidad.ciclo_vida (fin_bloqueo);

-- Leads suprimidos: se repite la supresión en citas/comunicación/tracking unos días, para limpiar lo que
-- otros dominios generen después de forma asíncrona (p. ej. el aviso de cancelación por CitaCancelada).
create table privacidad.barridos (
  lead_id uuid primary key,
  cliente_id uuid not null,
  repetir_hasta timestamptz not null,
  creado_en timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Solicitudes ARCO (PRV-02). El teléfono NUNCA en claro: solo su HMAC (HMAC_PEPPER, calculado en TS).
-- Plazos en días hábiles calculados en TS (src/domains/privacidad/domain/plazos.ts).
-- HMAC y leads se purgan 30 días después del cierre (aclaraciones); la fila se borra a los 2 años.
-- ---------------------------------------------------------------------
create table privacidad.solicitudes_arco (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null default '00000000-0000-0000-0000-000000000369',
  tipo text not null check (tipo in ('acceso', 'rectificacion', 'cancelacion', 'oposicion', 'revocacion')),
  canal text not null check (canal in ('correo', 'formulario', 'whatsapp', 'otro')),
  estado text not null default 'recibida' check (estado in ('recibida', 'ejecutada', 'respondida', 'rechazada')),
  telefono_hmac text check (telefono_hmac ~ '^[0-9a-f]{64}$'),
  leads uuid[] not null default '{}' check (cardinality(leads) <= 50),
  recibida_en timestamptz not null,
  limite_respuesta date not null,
  limite_ejecucion date not null,
  cerrada_en timestamptz,
  motivo text check (motivo ~ '^[a-z0-9_]{1,40}$'),
  resultado jsonb check (resultado is null or privacidad.solo_conteos(resultado)),
  creado_por uuid,
  datos_purgados_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  check (limite_respuesta >= (recibida_en at time zone 'America/Mexico_City')::date),
  check (limite_ejecucion >= limite_respuesta),
  check ((estado = 'recibida') = (cerrada_en is null)),
  check (datos_purgados_en is not null or telefono_hmac is not null or cardinality(leads) > 0)
);
create index solicitudes_arco_abiertas on privacidad.solicitudes_arco (limite_respuesta) where estado = 'recibida';
create index solicitudes_arco_hmac on privacidad.solicitudes_arco (telefono_hmac) where telefono_hmac is not null;

alter table privacidad.registro_supresiones enable row level security;
alter table privacidad.ciclo_vida enable row level security;
alter table privacidad.barridos enable row level security;
alter table privacidad.solicitudes_arco enable row level security;

revoke all on privacidad.registro_supresiones, privacidad.ciclo_vida, privacidad.barridos, privacidad.solicitudes_arco from public, anon, authenticated;
grant select on privacidad.registro_supresiones, privacidad.solicitudes_arco to authenticated;
create policy registro_admin on privacidad.registro_supresiones for select to authenticated using (shared.es_admin());
create policy solicitudes_admin on privacidad.solicitudes_arco for select to authenticated using (shared.es_admin());
grant all on privacidad.registro_supresiones, privacidad.ciclo_vida, privacidad.barridos, privacidad.solicitudes_arco to service_role;
grant usage, select on all sequences in schema privacidad to service_role;

-- ---------------------------------------------------------------------
-- Plazos (paridad con calcularPlazos de TS; ver privacidad.db.test.ts)
-- ---------------------------------------------------------------------
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
    ('asistio',         interval '90 days',  interval '30 days', 'anonimizar')
  ) t(etapa, a, b, x)
  where t.etapa = p_etapa
$$;

-- El panel pregunta si un lead está en bloqueo (solo admin debe verlo). Sin exponer la tabla.
create or replace function privacidad.api_lead_bloqueado(p_lead uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from privacidad.ciclo_vida c
                 where c.lead_id = p_lead and c.etapa <> 'sin_verificar' and c.fin_activo <= now())
$$;

-- ---------------------------------------------------------------------
-- Llamadas a otros dominios (solo si existen; si no, se reportan como faltantes)
-- ---------------------------------------------------------------------
-- Llama <schema>.<fn>(uuid) y devuelve {conteos, faltante?}.
create or replace function privacidad.llamar_lead(p_fn text, p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_fn not in ('captacion.suprimir_lead', 'captacion.anonimizar_lead', 'citas.suprimir_lead',
                  'comunicacion.suprimir_lead', 'tracking.suprimir_lead', 'shared.suprimir_lead') then
    raise exception 'función no permitida' using errcode = '22023';
  end if;
  if to_regprocedure(p_fn || '(uuid)') is null then
    return jsonb_build_object('faltante', p_fn);
  end if;
  execute format('select %s($1)', p_fn) into v using p_lead;
  return jsonb_build_object('conteos', coalesce(v, '{}'::jsonb));
end $$;

-- Supresión del lead en todos los schemas (sin registro). Orden: citas (cancela, CitaCancelada → zoho
-- borra el evento) → comunicación (cancela la cola) → tracking (agrega y borra crudos) → captación (borra el lead).
create or replace function privacidad.suprimir_en_dominios(p_lead uuid, p_incluir_captacion boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_fn text;
  v jsonb;
  v_conteos jsonb := '{}'::jsonb;
  v_faltantes text[] := '{}'::text[];
begin
  foreach v_fn in array array['citas.suprimir_lead', 'comunicacion.suprimir_lead', 'tracking.suprimir_lead', 'captacion.suprimir_lead', 'shared.suprimir_lead'] loop
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

-- Busca leads por HMAC del teléfono con la API de captación (si existe). NULL = API no disponible.
create or replace function privacidad.buscar_leads_por_telefono_hmac(p_hmac text) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare v uuid[];
begin
  if p_hmac is null or p_hmac !~ '^[0-9a-f]{64}$' then return '{}'::uuid[]; end if;
  if to_regprocedure('captacion.api_leads_por_telefono_hmac(text)') is null then return null; end if;
  execute 'select coalesce(array_agg(x.lead_id), ''{}'') from captacion.api_leads_por_telefono_hmac($1) x' into v using p_hmac;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Consumidor del outbox 'privacidad' → ciclo de vida
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
begin
  for i in 1 .. p_max_lotes loop
    v_n := 0;
    v_ultimo := null;
    for e in
      select * from shared.leer_outbox('privacidad', array['LeadCreado', 'WhatsAppVerificado', 'CitaConfirmada', 'CitaReprogramada',
        'CitaCancelada', 'AsistenciaRegistrada', 'LeadSuprimido'], p_lote)
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
      v_tiene_cita := found and c.etapa in ('cita_confirmada', 'cita_cancelada', 'no_asistio', 'asistio');
      v_etapa := null;
      v_cita := case when found then c.cita_id end;
      v_ref := case when found then c.referencia end;

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

-- Repite la supresión de los leads recién suprimidos (idempotente) y borra el barrido al vencer.
create or replace function privacidad.barrer(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v jsonb; v_conteos jsonb := '{}'::jsonb; v_faltantes jsonb := '[]'::jsonb; v_borrados int;
begin
  for r in select lead_id from privacidad.barridos order by creado_en limit 5000 loop
    v := privacidad.suprimir_en_dominios(r.lead_id, false);
    v_conteos := privacidad.sumar_conteos(v_conteos, v -> 'conteos');
    v_faltantes := v_faltantes || (v -> 'faltantes');
  end loop;
  delete from privacidad.barridos where repetir_hasta <= p_ahora;
  get diagnostics v_borrados = row_count;
  return jsonb_build_object('conteos', jsonb_build_object('barrido', v_conteos, 'barridos_cerrados', v_borrados), 'faltantes', v_faltantes);
end $$;

-- Bloqueo (fin del plazo activo) y anonimización (fin del bloqueo). En lotes.
-- Anonimizar = captacion.anonimizar_lead (R7) + desligar bitácora (comunicación) y crudos (tracking).
-- Citas y Zoho anonimizan lo suyo con sus propias reglas (cita + 60/120 días y cita + 30 días).
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
    foreach v_fn in array array['captacion.anonimizar_lead', 'comunicacion.suprimir_lead', 'tracking.suprimir_lead', 'shared.suprimir_lead'] loop
      v := privacidad.llamar_lead(v_fn, r.lead_id);
      if v ? 'faltante' then
        if not v_fn = any (v_faltantes) then v_faltantes := v_faltantes || v_fn; end if;
        if v_fn = 'captacion.anonimizar_lead' then v_ok := false; end if;
      else
        v_conteos := privacidad.sumar_conteos(v_conteos, jsonb_build_object(split_part(v_fn, '.', 1), v -> 'conteos'));
      end if;
    end loop;
    -- Sin la función de captación no se puede anonimizar: la fila se conserva para reintentar.
    if v_ok then
      delete from privacidad.ciclo_vida where lead_id = r.lead_id;
      v_anon := v_anon + 1;
    end if;
  end loop;

  -- Alerta: leads sin verificar que captación no ha suprimido (deberían irse a las 48 h).
  select count(*) into v_atrasados from privacidad.ciclo_vida
  where etapa = 'sin_verificar' and fin_activo + interval '7 days' <= p_ahora;

  return jsonb_build_object('conteos', jsonb_build_object('ciclo_bloqueados', v_bloqueados, 'ciclo_anonimizados', v_anon,
    'ciclo_sin_verificar_atrasados', v_atrasados, 'anonimizacion', v_conteos), 'faltantes', to_jsonb(v_faltantes));
end $$;

-- Contrato (regla 8) para los datos propios de privacidad. Idempotente.
create or replace function privacidad.retencion_aplicar(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_reg int; v_purgadas int; v_borradas int;
begin
  delete from privacidad.registro_supresiones where ejecutado_en < p_ahora - interval '2 years';
  get diagnostics v_reg = row_count;
  update privacidad.solicitudes_arco set telefono_hmac = null, leads = '{}', datos_purgados_en = p_ahora, actualizado_en = p_ahora
  where estado <> 'recibida' and datos_purgados_en is null and cerrada_en < p_ahora - interval '30 days';
  get diagnostics v_purgadas = row_count;
  delete from privacidad.solicitudes_arco where estado <> 'recibida' and cerrada_en < p_ahora - interval '2 years';
  get diagnostics v_borradas = row_count;
  return jsonb_build_object('registro_2_anios', v_reg, 'solicitudes_datos_purgados', v_purgadas, 'solicitudes_2_anios', v_borradas);
end $$;

-- Retención de UN dominio: llama a <schema>.retencion_aplicar por lotes hasta que no haya trabajo
-- (o hasta p_max_lotes). Cada lote es una subtransacción: si falla, se guarda solo el SQLSTATE.
create or replace function privacidad.retencion_dominio(p_schema text, p_ahora timestamptz, p_max_lotes int default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_total jsonb := '{}'::jsonb; v_lotes int := 0; v_error text;
begin
  if p_schema not in ('captacion', 'citas', 'comunicacion', 'tracking', 'shared') then
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

-- ---------------------------------------------------------------------
-- PRV-01 · Orquestador del cron diario. Idempotente; una sola corrida a la vez.
-- ---------------------------------------------------------------------
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
begin
  if not pg_try_advisory_xact_lock(hashtext('privacidad.retencion_diaria')) then
    return jsonb_build_object('omitida', true);
  end if;

  foreach d in array array['captacion', 'citas', 'comunicacion', 'tracking', 'shared'] loop
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

  -- Pasos propios: outbox → barridos → ciclo de vida → datos propios. Cada uno aislado.
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
  -- orden estable: dominios en el orden de la política
  v_faltantes := array(select x from unnest(array['captacion', 'citas', 'comunicacion', 'tracking', 'shared']) x where x = any (v_faltantes))
              || array(select x from unnest(v_faltantes) x where x <> all (array['captacion', 'citas', 'comunicacion', 'tracking', 'shared']));

  insert into privacidad.registro_supresiones (tipo, ejecutado_en, reglas, conteos, faltantes, errores)
  values ('retencion', p_ahora, v_reglas, v_conteos, v_faltantes, v_errores)
  returning id into v_id;

  return jsonb_build_object('registro_id', v_id, 'dominios', to_jsonb(v_dominios), 'faltantes', to_jsonb(v_faltantes),
    'errores', v_errores, 'lotes', v_lotes, 'conteos', v_conteos,
    'total', privacidad.total_conteos(v_conteos) - coalesce((v_conteos #>> '{tracking,particiones_creadas}')::numeric, 0));
end $$;

-- ---------------------------------------------------------------------
-- PRV-02 · Supresión del lead (ARCO / revocación) en todos los schemas + opt-out por HMAC
-- ---------------------------------------------------------------------
create or replace function privacidad.suprimir_lead_interno(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_cliente uuid;
begin
  if p_lead is null then raise exception 'p_lead requerido' using errcode = '22023'; end if;
  -- Ponerse al día con el outbox para que un evento pendiente del lead no lo "reviva" en ciclo_vida.
  perform privacidad.procesar_outbox(now(), 1000, 5);
  select cliente_id into v_cliente from privacidad.ciclo_vida where lead_id = p_lead;
  v := privacidad.suprimir_en_dominios(p_lead, true);
  delete from privacidad.ciclo_vida where lead_id = p_lead;
  insert into privacidad.barridos (lead_id, cliente_id, repetir_hasta)
  values (p_lead, coalesce(v_cliente, '00000000-0000-0000-0000-000000000369'), now() + interval '3 days')
  on conflict (lead_id) do update set repetir_hasta = excluded.repetir_hasta;
  return v || jsonb_build_object('cliente_id', v_cliente);
end $$;

-- Opt-out permanente con la API de comunicación. NULL si la función no existe.
create or replace function privacidad.registrar_opt_out(p_hmac text) returns int
language plpgsql security definer set search_path = '' as $$
declare v boolean;
begin
  if p_hmac is null then return 0; end if;
  if p_hmac !~ '^[0-9a-f]{64}$' then raise exception 'HMAC inválido' using errcode = '22023'; end if;
  if to_regprocedure('comunicacion.registrar_opt_out(text,uuid,text)') is null then return null; end if;
  execute 'select comunicacion.registrar_opt_out($1, null, ''arco'')' into v using p_hmac;
  return case when v then 1 else 0 end;
end $$;

create or replace function privacidad.suprimir_lead(p_lead uuid, p_telefono_hmac text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_opt int; v_conteos jsonb; v_faltantes text[];
begin
  v := privacidad.suprimir_lead_interno(p_lead);
  v_opt := privacidad.registrar_opt_out(p_telefono_hmac);
  v_faltantes := array(select jsonb_array_elements_text(v -> 'faltantes'));
  if p_telefono_hmac is not null and v_opt is null then v_faltantes := v_faltantes || 'comunicacion.registrar_opt_out'::text; end if;
  v_conteos := (v -> 'conteos') || jsonb_build_object('opt_out', coalesce(v_opt, 0));
  insert into privacidad.registro_supresiones (cliente_id, tipo, ejecutado_en, reglas, conteos, faltantes)
  values (coalesce((v ->> 'cliente_id')::uuid, '00000000-0000-0000-0000-000000000369'), 'supresion', now(),
          array['privacidad.suprimir_lead'], v_conteos, v_faltantes);
  return jsonb_build_object('conteos', v_conteos, 'faltantes', to_jsonb(v_faltantes));
end $$;

-- Contrato regla 8: suprime el lead en todos los schemas y lo registra (sin opt-out: no hay teléfono).
create or replace function privacidad.suprimir_lead(p_lead uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select privacidad.suprimir_lead(p_lead, null::text)
$$;

-- ---------------------------------------------------------------------
-- PRV-02 · Solicitudes ARCO
-- ---------------------------------------------------------------------
create or replace function privacidad.arco_registrar(p_tipo text, p_canal text, p_telefono_hmac text, p_leads uuid[],
  p_recibida_en timestamptz, p_limite_respuesta date, p_limite_ejecucion date, p_creado_por uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_encontrados uuid[];
begin
  v_encontrados := coalesce(privacidad.buscar_leads_por_telefono_hmac(p_telefono_hmac), '{}');
  insert into privacidad.solicitudes_arco (tipo, canal, telefono_hmac, leads, recibida_en, limite_respuesta, limite_ejecucion, creado_por)
  values (p_tipo, p_canal, p_telefono_hmac,
          array(select distinct x from unnest(coalesce(p_leads, '{}') || v_encontrados) x where x is not null),
          p_recibida_en, p_limite_respuesta, p_limite_ejecucion, p_creado_por)
  returning id into v_id;
  return v_id;
end $$;

-- Ejecuta una cancelación / oposición / revocación: supresión de cada lead + opt-out + registro.
create or replace function privacidad.arco_ejecutar(p_solicitud uuid, p_ahora timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s privacidad.solicitudes_arco;
  v_leads uuid[];
  v_lead uuid;
  v jsonb;
  v_conteos jsonb := '{}'::jsonb;
  v_faltantes text[] := '{}'::text[];
  v_opt int;
  v_busqueda uuid[];
begin
  select * into s from privacidad.solicitudes_arco where id = p_solicitud for update;
  if not found then raise exception 'NO_ENCONTRADA' using errcode = 'P0002'; end if;
  if s.estado <> 'recibida' then raise exception 'TRANSICION_INVALIDA' using errcode = '22023'; end if;
  if s.tipo not in ('cancelacion', 'oposicion', 'revocacion') then raise exception 'TIPO_NO_EJECUTABLE' using errcode = '22023'; end if;

  v_busqueda := privacidad.buscar_leads_por_telefono_hmac(s.telefono_hmac);
  if s.telefono_hmac is not null and v_busqueda is null then v_faltantes := v_faltantes || 'captacion.api_leads_por_telefono_hmac'::text; end if;
  v_leads := array(select distinct x from unnest(s.leads || coalesce(v_busqueda, '{}')) x);

  foreach v_lead in array v_leads loop
    v := privacidad.suprimir_lead_interno(v_lead);
    v_conteos := privacidad.sumar_conteos(v_conteos, v -> 'conteos');
    v_faltantes := v_faltantes || array(select x from jsonb_array_elements_text(v -> 'faltantes') x where not x = any (v_faltantes));
  end loop;

  v_opt := privacidad.registrar_opt_out(s.telefono_hmac);
  if s.telefono_hmac is not null and v_opt is null then v_faltantes := v_faltantes || 'comunicacion.registrar_opt_out'::text; end if;
  v_conteos := v_conteos || jsonb_build_object('leads', cardinality(v_leads), 'opt_out', coalesce(v_opt, 0));

  update privacidad.solicitudes_arco set estado = 'ejecutada', cerrada_en = p_ahora, resultado = v_conteos, leads = v_leads, actualizado_en = p_ahora
  where id = p_solicitud;
  insert into privacidad.registro_supresiones (tipo, ejecutado_en, reglas, conteos, faltantes, solicitud_id)
  values ('arco', p_ahora, array['privacidad.arco_' || s.tipo], v_conteos, v_faltantes, p_solicitud);
  return jsonb_build_object('conteos', v_conteos, 'faltantes', to_jsonb(v_faltantes));
end $$;

create or replace function privacidad.arco_responder(p_solicitud uuid, p_estado text, p_motivo text, p_ahora timestamptz default now()) returns void
language plpgsql security definer set search_path = '' as $$
declare s privacidad.solicitudes_arco;
begin
  if p_estado not in ('respondida', 'rechazada') then raise exception 'estado inválido' using errcode = '22023'; end if;
  select * into s from privacidad.solicitudes_arco where id = p_solicitud for update;
  if not found then raise exception 'NO_ENCONTRADA' using errcode = 'P0002'; end if;
  if s.estado <> 'recibida' then raise exception 'TRANSICION_INVALIDA' using errcode = '22023'; end if;
  update privacidad.solicitudes_arco set estado = p_estado, motivo = p_motivo, cerrada_en = p_ahora, actualizado_en = p_ahora where id = p_solicitud;
  insert into privacidad.registro_supresiones (tipo, ejecutado_en, reglas, solicitud_id)
  values ('arco', p_ahora, array['privacidad.arco_' || s.tipo || '_' || p_estado], p_solicitud);
end $$;

-- ---------------------------------------------------------------------
-- Permisos: todo solo service_role, salvo api_lead_bloqueado (panel) y los validadores de CHECK.
-- ---------------------------------------------------------------------
revoke all on all functions in schema privacidad from public, anon, authenticated;
grant execute on all functions in schema privacidad to service_role;
grant execute on function privacidad.api_lead_bloqueado(uuid) to authenticated;
