-- =====================================================================
-- Contratación y entrega de expediente (dueño: dashboard/panel) · pedido del orquestador (ola 2)
-- Desde el detalle de cita, admin o reclutador asignado marcan a un candidato que ASISTIÓ como
-- "contratado" y después "expediente entregado al cliente". Cada paso publica LeadContratado
-- (src/shared/eventos.ts): privacidad lo consume (retención "hasta la entrega") y tracking lo envía
-- a CAPI como evento offline (TRK-09; sugerido: solo el primero, entregado_en = null).
-- =====================================================================

-- ---------------------------------------------------------------------
-- API pública MÍNIMA que el panel necesita de citas (regla 1 de CONTRATOS: no se leen tablas ajenas).
-- Creada aquí por pedido del orquestador; el dueño de citas puede adoptarla en su bloque.
-- security_invoker: respeta el RLS de citas.citas para quien consulta.
-- ---------------------------------------------------------------------
create or replace view citas.api_citas_panel with (security_invoker = true) as
select c.id as cita_id, c.vacante_id, c.cliente_id, c.lead_id, c.estado, c.inicio, c.fin
from citas.citas c;
comment on view citas.api_citas_panel is
  'API pública (creada por dashboard/panel): cita → vacante, cliente, lead y estado. security_invoker.';
revoke all on citas.api_citas_panel from public, anon, authenticated;
grant select on citas.api_citas_panel to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Estado de contratación por cita (cliente_id + RLS, regla 4).
-- ---------------------------------------------------------------------
create table dashboard.contrataciones (
  cita_id uuid primary key,
  cliente_id uuid not null references shared.clientes(id),
  vacante_id uuid not null references shared.vacantes(id),
  lead_id uuid,                                   -- null tras supresión o retención
  contratado_en timestamptz not null default now(),
  contratado_por uuid,
  contratado_event_id uuid not null,
  entregado_en timestamptz,
  entregado_por uuid,
  entregado_event_id uuid,
  anonimizado_en timestamptz,
  check ((entregado_en is null) = (entregado_event_id is null)),
  check (anonimizado_en is null or lead_id is null)
);
create index contrataciones_vacante on dashboard.contrataciones (vacante_id);
create index contrataciones_lead on dashboard.contrataciones (lead_id) where lead_id is not null;
alter table dashboard.contrataciones enable row level security;

-- Panel: lectura sin lead_id, filtrada por vacante visible. Sin escritura directa.
revoke all on dashboard.contrataciones from public, anon, authenticated;
grant select (cita_id, cliente_id, vacante_id, contratado_en, entregado_en) on dashboard.contrataciones to authenticated;
grant all on dashboard.contrataciones to service_role;
create policy contrataciones_lectura on dashboard.contrataciones for select to authenticated using (shared.puede_ver_vacante(vacante_id));

-- ---------------------------------------------------------------------
-- registrar_contratacion(p_cita, p_entregado):
--   false → contratado (idempotente)   true → entregado (si no estaba contratado, registra ambos en un paso)
-- Solo citas en estado 'asistio' con lead. Publica LeadContratado una vez por paso.
-- ---------------------------------------------------------------------
create or replace function dashboard.registrar_contratacion(p_cita uuid, p_entregado boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_usuario uuid := auth.uid();
  c record;
  k dashboard.contrataciones;
  v_event uuid;
  v_ahora timestamptz := now();
begin
  if v_usuario is null then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;
  select a.cita_id, a.vacante_id, a.cliente_id, a.lead_id, a.estado into c from citas.api_citas_panel a where a.cita_id = p_cita;
  if not found then
    raise exception 'NO_ENCONTRADA' using errcode = 'P0002';
  end if;
  if not shared.puede_operar_vacante(c.vacante_id) then
    raise exception 'PERMISO_DENEGADO' using errcode = '42501';
  end if;

  select * into k from dashboard.contrataciones where cita_id = p_cita for update;
  if not found then
    if c.estado <> 'asistio' or c.lead_id is null then
      raise exception 'TRANSICION_INVALIDA: % -> contratado', c.estado using errcode = '22023';
    end if;
    v_event := gen_random_uuid();
    insert into dashboard.contrataciones (cita_id, cliente_id, vacante_id, lead_id, contratado_en, contratado_por, contratado_event_id,
      entregado_en, entregado_por, entregado_event_id)
    values (p_cita, c.cliente_id, c.vacante_id, c.lead_id, v_ahora, v_usuario, v_event,
      case when p_entregado then v_ahora end, case when p_entregado then v_usuario end, case when p_entregado then v_event end)
    returning * into k;
    perform shared.publicar_evento('LeadContratado', jsonb_build_object(
      'lead_id', c.lead_id, 'vacante_id', c.vacante_id, 'cliente_id', c.cliente_id, 'cita_id', p_cita,
      'entregado_en', case when p_entregado then citas.iso(v_ahora) end, 'event_id', v_event), c.cliente_id);
  elsif p_entregado and k.entregado_en is null then
    if k.lead_id is null then
      raise exception 'TRANSICION_INVALIDA: lead suprimido' using errcode = '22023';
    end if;
    v_event := gen_random_uuid();
    update dashboard.contrataciones set entregado_en = v_ahora, entregado_por = v_usuario, entregado_event_id = v_event
    where cita_id = p_cita returning * into k;
    perform shared.publicar_evento('LeadContratado', jsonb_build_object(
      'lead_id', k.lead_id, 'vacante_id', k.vacante_id, 'cliente_id', k.cliente_id, 'cita_id', p_cita,
      'entregado_en', citas.iso(v_ahora), 'event_id', v_event), k.cliente_id);
  end if;

  return jsonb_build_object(
    'cita_id', p_cita,
    'estado', case when k.entregado_en is not null then 'entregado' else 'contratado' end,
    'contratado_en', k.contratado_en,
    'entregado_en', k.entregado_en,
    'event_id', case when p_entregado then coalesce(k.entregado_event_id, k.contratado_event_id) else k.contratado_event_id end);
end $$;

-- ---------------------------------------------------------------------
-- Privacidad (regla 8). Propuesta de plazos para privacidad: lead_id se desliga 30 días después de la
-- entrega, o 60 días después de contratar si nunca se entregó. Los conteos se conservan.
-- ---------------------------------------------------------------------
create or replace function dashboard.suprimir_lead(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update dashboard.contrataciones set lead_id = null, anonimizado_en = now() where lead_id = p_lead;
  get diagnostics n = row_count;
  return jsonb_build_object('contrataciones', n);
end $$;

create or replace function dashboard.retencion_aplicar(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a int; b int;
begin
  update dashboard.contrataciones set lead_id = null, anonimizado_en = p_ahora
  where lead_id is not null and entregado_en is not null and entregado_en < p_ahora - interval '30 days';
  get diagnostics a = row_count;
  update dashboard.contrataciones set lead_id = null, anonimizado_en = p_ahora
  where lead_id is not null and entregado_en is null and contratado_en < p_ahora - interval '60 days';
  get diagnostics b = row_count;
  return jsonb_build_object('contratacion_entregada_30d', a, 'contratacion_sin_entrega_60d', b);
end $$;

revoke all on function dashboard.registrar_contratacion(uuid, boolean) from public, anon;
grant execute on function dashboard.registrar_contratacion(uuid, boolean) to authenticated, service_role;
revoke all on function dashboard.suprimir_lead(uuid), dashboard.retencion_aplicar(timestamptz) from public, anon, authenticated;
grant execute on function dashboard.suprimir_lead(uuid), dashboard.retencion_aplicar(timestamptz) to service_role;
