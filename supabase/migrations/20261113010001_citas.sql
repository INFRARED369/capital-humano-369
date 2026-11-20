-- =====================================================================
-- Citas · motor de disponibilidad y ciclo de vida (F1: CIT-01…CIT-07, CIT-10; C11, C12, C14; S1, S2)
-- Dueño: dominio citas. Las reglas (ReglasAgenda) se validan en TS (src/domains/citas/domain);
-- aquí solo se garantiza la atomicidad del conteo de capacidad/cupo bajo un lock por (vacante, día local).
-- =====================================================================

create table citas.citas (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references shared.clientes(id),
  vacante_id uuid not null references shared.vacantes(id),
  -- null cuando el lead fue suprimido o anonimizado (R7)
  lead_id uuid,
  inicio timestamptz not null,
  fin timestamptz not null,
  -- día local de la vacante (zona de sus reglas): base del cupo diario y del lock
  dia_local date not null,
  estado text not null default 'retenida'
    check (estado in ('retenida', 'confirmada', 'asistio', 'no_asistio', 'cancelada', 'reprogramada', 'expirada')),
  -- versión de config.vacantes_reglas con la que se resolvió (0 = plantilla por defecto) (C13)
  reglas_version int not null check (reglas_version >= 0),
  expira_en timestamptz,
  -- código del sistema (ttl, reemplazada, otp_fallido, candidato, supresion…); nunca texto libre del candidato
  motivo text check (motivo is null or motivo ~ '^[a-z0-9_]{1,40}$'),
  cita_anterior_id uuid references citas.citas(id),
  confirmada_en timestamptz,
  cancelada_en timestamptz,
  -- asistencia y evaluación (CIT-10)
  asistio boolean,
  evaluacion jsonb check (evaluacion is null or jsonb_typeof(evaluacion) = 'object'),
  asistencia_por uuid,
  asistencia_en timestamptz,
  asistencia_event_id uuid,
  anonimizada_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  check (fin > inicio),
  check (estado <> 'retenida' or expira_en is not null),
  -- R7: una cita anonimizada conserva solo vacante, fechas y estado
  check (anonimizada_en is null or (lead_id is null and evaluacion is null))
);

-- NFR-ESC-05: GET slots lee la ocupación por (vacante, rango de inicio)
create index citas_vacante_inicio on citas.citas (vacante_id, inicio);
-- Conteo bajo lock por (vacante, día) de las que ocupan capacidad
create index citas_activas_dia on citas.citas (vacante_id, dia_local) where estado in ('retenida', 'confirmada');
-- Expiración de retenciones (C12)
create index citas_retenidas_expira on citas.citas (expira_en) where estado = 'retenida';
create index citas_lead on citas.citas (lead_id) where lead_id is not null;
-- Un lead tiene a lo más una cita activa por vacante
create unique index citas_lead_activa_unica on citas.citas (lead_id, vacante_id) where estado in ('retenida', 'confirmada') and lead_id is not null;
-- Retención por fecha de la cita
create index citas_retencion on citas.citas (estado, inicio) where lead_id is not null;

alter table citas.citas enable row level security;

-- ---------------------------------------------------------------------
-- Formato ISO idéntico a Date.prototype.toISOString (payloads de eventos)
-- ---------------------------------------------------------------------
create or replace function citas.iso(p timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- ---------------------------------------------------------------------
-- C12 · Expira retenciones vencidas (opcionalmente de una vacante) y publica CitaExpirada.
-- SKIP LOCKED: si una retención está siendo confirmada en otra transacción, no se toca.
-- ---------------------------------------------------------------------
create or replace function citas.expirar_retenciones(p_ahora timestamptz, p_vacante uuid default null, p_limite int default 500)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  with sel as (
    select c.id from citas.citas c
    where c.estado = 'retenida' and c.expira_en <= p_ahora and (p_vacante is null or c.vacante_id = p_vacante)
    order by c.expira_en
    limit p_limite
    for update skip locked
  ), exp as (
    update citas.citas c set estado = 'expirada', motivo = 'ttl', actualizado_en = p_ahora
    from sel where c.id = sel.id
    returning c.id, c.lead_id, c.vacante_id, c.cliente_id
  )
  select count(shared.publicar_evento('CitaExpirada',
    jsonb_build_object('cita_id', exp.id, 'lead_id', exp.lead_id, 'vacante_id', exp.vacante_id, 'cliente_id', exp.cliente_id),
    exp.cliente_id)) into v_n
  from exp;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- CIT-05 / C11 · Reserva atómica. Toma pg_advisory_xact_lock por (vacante, día local) y cuenta
-- bajo el lock las retenidas vigentes + confirmadas. Devuelve jsonb:
--   { resultado: OK | SLOT_LLENO | CUPO_DIARIO | VACANTE_NO_ENCONTRADA | CITA_ACTIVA, cita_id?, cliente_id?, expira_en? }
-- p_estado = 'confirmada' se usa al reprogramar (el candidato ya verificó su WhatsApp).
-- ---------------------------------------------------------------------
create or replace function citas.retener(
  p_vacante uuid, p_lead uuid, p_inicio timestamptz, p_fin timestamptz, p_dia date,
  p_capacidad int, p_cupo int, p_empalmes boolean, p_reglas_version int,
  p_expira_en timestamptz, p_ahora timestamptz, p_estado text default 'retenida', p_cita_anterior uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cliente uuid;
  v_slot int;
  v_dia int;
  v_id uuid;
  v_n int;
begin
  if p_estado is null or p_estado not in ('retenida', 'confirmada') then
    raise exception 'p_estado inválido: %', p_estado using errcode = '22023';
  end if;
  if p_lead is null or p_fin <= p_inicio or p_capacidad < 1 or p_cupo < 1 or p_reglas_version < 0
     or (p_estado = 'retenida' and p_expira_en is null) then
    raise exception 'Parámetros de retención inválidos' using errcode = '22023';
  end if;

  select v.cliente_id into v_cliente from shared.vacantes v where v.id = p_vacante and v.activa;
  if v_cliente is null then
    return jsonb_build_object('resultado', 'VACANTE_NO_ENCONTRADA');
  end if;

  perform pg_advisory_xact_lock(hashtext('citas.retener:' || p_vacante::text), p_dia - date '2000-01-01');

  perform citas.expirar_retenciones(p_ahora, p_vacante);

  -- Una retención previa del mismo lead en la vacante se reemplaza por la nueva.
  with prev as (
    update citas.citas c set estado = 'expirada', motivo = 'reemplazada', actualizado_en = p_ahora
    where c.lead_id = p_lead and c.vacante_id = p_vacante and c.estado = 'retenida'
    returning c.id, c.lead_id, c.vacante_id, c.cliente_id
  )
  select count(shared.publicar_evento('CitaExpirada',
    jsonb_build_object('cita_id', prev.id, 'lead_id', prev.lead_id, 'vacante_id', prev.vacante_id, 'cliente_id', prev.cliente_id),
    prev.cliente_id)) into v_n
  from prev;

  if exists (select 1 from citas.citas c where c.lead_id = p_lead and c.vacante_id = p_vacante and c.estado = 'confirmada') then
    return jsonb_build_object('resultado', 'CITA_ACTIVA');
  end if;

  select
    count(*) filter (where case when p_empalmes then c.inicio = p_inicio else c.inicio < p_fin and c.fin > p_inicio end),
    count(*)
  into v_slot, v_dia
  from citas.citas c
  where c.vacante_id = p_vacante and c.dia_local = p_dia
    and (c.estado = 'confirmada' or (c.estado = 'retenida' and c.expira_en > p_ahora));

  if v_slot >= p_capacidad then
    return jsonb_build_object('resultado', 'SLOT_LLENO');
  end if;
  if v_dia >= p_cupo then
    return jsonb_build_object('resultado', 'CUPO_DIARIO');
  end if;

  insert into citas.citas (cliente_id, vacante_id, lead_id, inicio, fin, dia_local, estado, reglas_version,
                           expira_en, confirmada_en, cita_anterior_id, creado_en, actualizado_en)
  values (v_cliente, p_vacante, p_lead, p_inicio, p_fin, p_dia, p_estado, p_reglas_version,
          case when p_estado = 'retenida' then p_expira_en end,
          case when p_estado = 'confirmada' then p_ahora end,
          p_cita_anterior, p_ahora, p_ahora)
  returning id into v_id;

  if p_estado = 'retenida' then
    perform shared.publicar_evento('CitaRetenida', jsonb_build_object(
      'cita_id', v_id, 'lead_id', p_lead, 'vacante_id', p_vacante, 'cliente_id', v_cliente,
      'inicio', citas.iso(p_inicio), 'expira_en', citas.iso(p_expira_en)), v_cliente);
  end if;

  return jsonb_build_object('resultado', 'OK', 'cita_id', v_id, 'cliente_id', v_cliente,
                            'expira_en', case when p_estado = 'retenida' then citas.iso(p_expira_en) end);
end $$;

-- ---------------------------------------------------------------------
-- CIT-10 · Asistencia y evaluación desde el panel. Valida puede_operar_vacante (admin o reclutador
-- asignado; el rol cliente es solo lectura). confirmada → asistio | no_asistio y publica
-- AsistenciaRegistrada con event_id (TRK-09). Repetir con el mismo valor solo actualiza la evaluación.
-- ---------------------------------------------------------------------
create or replace function citas.registrar_asistencia(p_cita uuid, p_asistio boolean, p_evaluacion jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r citas.citas;
  v_estado text;
  v_event uuid;
begin
  if p_asistio is null then
    raise exception 'ASISTENCIA_REQUERIDA' using errcode = '22023';
  end if;
  if p_evaluacion is not null and (jsonb_typeof(p_evaluacion) <> 'object' or octet_length(p_evaluacion::text) > 8192) then
    raise exception 'EVALUACION_INVALIDA' using errcode = '22023';
  end if;
  v_estado := case when p_asistio then 'asistio' else 'no_asistio' end;

  select * into r from citas.citas c where c.id = p_cita for update;
  if not found then
    raise exception 'NO_ENCONTRADA' using errcode = 'P0002';
  end if;
  if not shared.puede_operar_vacante(r.vacante_id) then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;

  if r.estado = 'confirmada' and r.lead_id is not null then
    v_event := gen_random_uuid();
    update citas.citas set estado = v_estado, asistio = p_asistio, evaluacion = p_evaluacion,
      asistencia_por = auth.uid(), asistencia_en = now(), asistencia_event_id = v_event, actualizado_en = now()
    where id = p_cita;
    perform shared.publicar_evento('AsistenciaRegistrada', jsonb_build_object(
      'cita_id', r.id, 'lead_id', r.lead_id, 'vacante_id', r.vacante_id, 'cliente_id', r.cliente_id,
      'asistio', p_asistio, 'event_id', v_event), r.cliente_id);
  elsif r.estado = v_estado and r.lead_id is not null then
    update citas.citas set evaluacion = coalesce(p_evaluacion, evaluacion), actualizado_en = now() where id = p_cita;
    v_event := r.asistencia_event_id;
  else
    raise exception 'TRANSICION_INVALIDA: % -> %', r.estado, v_estado using errcode = '22023';
  end if;

  return jsonb_build_object('cita_id', r.id, 'estado', v_estado, 'event_id', v_event);
end $$;

-- ---------------------------------------------------------------------
-- Vista pública para dashboard/panel (security_invoker: respeta el RLS de citas.citas).
-- ---------------------------------------------------------------------
create view citas.api_ocupacion_diaria with (security_invoker = true) as
select
  c.vacante_id,
  c.dia_local as dia,
  (count(*) filter (where c.estado = 'retenida' and c.expira_en > now()))::int as retenidas,
  (count(*) filter (where c.estado = 'confirmada'))::int as confirmadas,
  (count(*) filter (where c.estado = 'asistio'))::int as asistio,
  (count(*) filter (where c.estado = 'no_asistio'))::int as no_asistio,
  coalesce((select (rv.reglas -> 'agenda' ->> 'cupo_diario')::int from config.reglas_vigentes(c.vacante_id) rv), 10) as cupo,
  c.cliente_id
from citas.citas c
group by c.vacante_id, c.dia_local, c.cliente_id;

-- ---------------------------------------------------------------------
-- Permisos (S1, S2): anon nada; el panel solo lee lo que puede ver; escritura por funciones.
-- ---------------------------------------------------------------------
revoke all on citas.citas, citas.api_ocupacion_diaria from public, anon, authenticated;
grant select on citas.citas, citas.api_ocupacion_diaria to authenticated;
grant all on citas.citas to service_role;
grant select on citas.api_ocupacion_diaria to service_role;

create policy citas_lectura on citas.citas for select to authenticated using (shared.puede_ver_vacante(vacante_id));

revoke execute on function citas.iso(timestamptz) from public;
revoke execute on function citas.expirar_retenciones(timestamptz, uuid, int) from public;
revoke execute on function citas.retener(uuid, uuid, timestamptz, timestamptz, date, int, int, boolean, int, timestamptz, timestamptz, text, uuid) from public;
revoke execute on function citas.registrar_asistencia(uuid, boolean, jsonb) from public;
grant execute on function citas.iso(timestamptz) to service_role;
grant execute on function citas.expirar_retenciones(timestamptz, uuid, int) to service_role;
grant execute on function citas.retener(uuid, uuid, timestamptz, timestamptz, date, int, int, boolean, int, timestamptz, timestamptz, text, uuid) to service_role;
grant execute on function citas.registrar_asistencia(uuid, boolean, jsonb) to authenticated, service_role;
