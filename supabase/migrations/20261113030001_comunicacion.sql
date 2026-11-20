-- =====================================================================
-- F3 · Comunicación (dueño: comunicacion)
-- Bitácora de mensajes SIN texto ni destino (Política de retención), costos por intento
-- (COM-03), opt-out solo con HMAC del teléfono, anti-replay de webhooks (NFR-SEG-05).
-- La cola (shared.cola, cola = 'comunicacion') solo lleva {"mensaje_id": ...}.
-- =====================================================================

create table comunicacion.mensajes (
  id uuid primary key,
  cliente_id uuid not null references shared.clientes(id),
  vacante_id uuid not null references shared.vacantes(id),
  lead_id uuid,                 -- se quita a los 90 días o al suprimir el lead
  cita_id uuid,                 -- para cancelar recordatorios (M7); se quita junto con lead_id
  tipo text not null check (tipo in ('otp','confirmacion','recordatorio_24h','recordatorio_2h','cancelacion','reprogramacion','agradecimiento')),
  canal text not null check (canal in ('whatsapp','email','sms')),
  plantilla text,               -- '<tipo>@vacante:v<n>' | '<tipo>@defecto' (nunca el texto)
  estado text not null default 'pendiente'
    check (estado in ('pendiente','enviando','reintento','enviado','fallido','cancelado','omitido')),
  motivo text check (length(motivo) <= 200),
  proveedor text,
  proveedor_id text,
  estado_entrega text check (estado_entrega in ('entregado','leido','fallido')),
  costo_mxn numeric(12,4) not null default 0,
  intentos smallint not null default 0,
  llave text not null unique check (length(llave) between 1 and 200),
  prioridad smallint not null check (prioridad between 0 and 9),
  programado_para timestamptz not null default now(),
  -- Datos de trabajo efímeros (se borran al terminar): solo fecha/hora/links, nunca PII.
  variables jsonb,
  codigo_cifrado text,          -- OTP AES-GCM (OTP_ENC_KEY); se borra al terminar o a las 24 h
  correlation_id text check (length(correlation_id) <= 64),
  reclamado_hasta timestamptz,  -- lease del worker (M3)
  enviado_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index mensajes_lead on comunicacion.mensajes (lead_id) where lead_id is not null;
create index mensajes_cita_activos on comunicacion.mensajes (cita_id) where estado in ('pendiente','reintento');
create index mensajes_proveedor_id on comunicacion.mensajes (proveedor, proveedor_id) where proveedor_id is not null;
create index mensajes_retencion on comunicacion.mensajes (creado_en) where lead_id is not null;
create index mensajes_vacante on comunicacion.mensajes (vacante_id, creado_en);

create table comunicacion.intentos (
  id bigint generated always as identity primary key,
  mensaje_id uuid not null references comunicacion.mensajes(id),
  cliente_id uuid not null references shared.clientes(id),
  vacante_id uuid not null references shared.vacantes(id),
  canal text not null check (canal in ('whatsapp','email','sms')),
  proveedor text not null,
  intento smallint not null check (intento >= 1),
  resultado text not null check (resultado in ('enviado','error')),
  error text check (length(error) <= 200),
  proveedor_id text,
  costo_mxn numeric(12,4) not null default 0 check (costo_mxn >= 0),
  creado_en timestamptz not null default now()
);
create index intentos_costos on comunicacion.intentos (cliente_id, vacante_id, creado_en);
create index intentos_mensaje on comunicacion.intentos (mensaje_id);

-- Opt-out permanente (COM-05, ARCO). Global: el sistema es el único emisor (COM-07).
-- cliente_id es opcional: una baja por WhatsApp ("BAJA") no siempre se puede atribuir a un cliente.
create table comunicacion.opt_out (
  telefono_hmac text primary key check (telefono_hmac ~ '^[0-9a-f]{64}$'),
  cliente_id uuid references shared.clientes(id),
  origen text not null check (origen in ('webhook','arco','panel')),
  creado_en timestamptz not null default now()
);

-- Anti-replay de webhooks (M5). Técnico, sin tenant: se purga a los 7 días.
create table comunicacion.webhooks_vistos (
  proveedor text not null check (proveedor in ('evolution','nbx')),
  evento_id text not null check (length(evento_id) <= 128),
  cliente_id uuid,
  visto_en timestamptz not null default now(),
  primary key (proveedor, evento_id)
);

alter table comunicacion.mensajes enable row level security;
alter table comunicacion.intentos enable row level security;
alter table comunicacion.opt_out enable row level security;
alter table comunicacion.webhooks_vistos enable row level security;

-- Panel: solo lectura de bitácora y costos de las vacantes que puede ver. Sin escritura.
grant select on comunicacion.mensajes, comunicacion.intentos to authenticated;
create policy mensajes_lectura on comunicacion.mensajes for select to authenticated using (shared.puede_ver_vacante(vacante_id));
create policy intentos_lectura on comunicacion.intentos for select to authenticated using (shared.puede_ver_vacante(vacante_id));

grant all on comunicacion.mensajes, comunicacion.intentos, comunicacion.opt_out, comunicacion.webhooks_vistos to service_role;
grant usage, select on all sequences in schema comunicacion to service_role;

-- ---------------------------------------------------------------------
-- Vistas públicas (prefijo api_) para Dashboard: agregados sin lead_id.
-- security_invoker: aplican la RLS de intentos/mensajes del usuario que consulta.
-- ---------------------------------------------------------------------
create view comunicacion.api_costos with (security_invoker = true) as
  select cliente_id, vacante_id, canal, proveedor,
         (creado_en at time zone 'America/Mexico_City')::date as dia,
         count(*)::int as intentos,
         count(*) filter (where resultado = 'enviado')::int as exitosos,
         sum(costo_mxn) as costo_mxn
  from comunicacion.intentos
  group by 1, 2, 3, 4, 5;

-- NFR-OBS-01: fallos definitivos (dead letter) por día para alertas y DSH.
create view comunicacion.api_fallos with (security_invoker = true) as
  select cliente_id, vacante_id, canal, tipo,
         (actualizado_en at time zone 'America/Mexico_City')::date as dia,
         count(*)::int as fallidos
  from comunicacion.mensajes
  where estado = 'fallido'
  group by 1, 2, 3, 4, 5;

revoke all on comunicacion.api_costos, comunicacion.api_fallos from public, anon;
grant select on comunicacion.api_costos, comunicacion.api_fallos to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Privacidad (contrato §8 de CONTRATOS.md)
-- ---------------------------------------------------------------------

-- Supresión ARCO / revocación: cancela lo pendiente del lead y desliga la bitácora.
create or replace function comunicacion.suprimir_lead(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_cancelados int; v_desligados int;
begin
  update comunicacion.mensajes set estado = 'cancelado', motivo = 'LEAD_SUPRIMIDO', actualizado_en = now()
  where lead_id = p_lead and estado in ('pendiente', 'reintento', 'enviando');
  get diagnostics v_cancelados = row_count;
  update comunicacion.mensajes set lead_id = null, cita_id = null, variables = null, codigo_cifrado = null, actualizado_en = now()
  where lead_id = p_lead;
  get diagnostics v_desligados = row_count;
  return jsonb_build_object('cancelados', v_cancelados, 'desligados', v_desligados);
end $$;

-- Retención diaria: idempotente y en lotes de 5000.
create or replace function comunicacion.retencion_aplicar(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_bitacora int := 0; v_otp int := 0; v_webhooks int := 0; v_n int;
begin
  -- Bitácora: 90 días ligada al lead; luego se quita lead_id (los costos en intentos no tienen lead_id).
  loop
    update comunicacion.mensajes set lead_id = null, cita_id = null, variables = null, codigo_cifrado = null
    where id in (select id from comunicacion.mensajes where lead_id is not null and creado_en < p_ahora - interval '90 days' limit 5000);
    get diagnostics v_n = row_count;
    v_bitacora := v_bitacora + v_n;
    exit when v_n < 5000;
  end loop;
  -- Código OTP: se borra a las 24 h aunque el mensaje siga sin terminar.
  update comunicacion.mensajes set codigo_cifrado = null
  where codigo_cifrado is not null and creado_en < p_ahora - interval '24 hours';
  get diagnostics v_otp = row_count;
  -- Anti-replay: la tolerancia es de 5 min; 7 días es de sobra.
  delete from comunicacion.webhooks_vistos where visto_en < p_ahora - interval '7 days';
  get diagnostics v_webhooks = row_count;
  return jsonb_build_object('bitacora_desligada', v_bitacora, 'otp_borrados', v_otp, 'webhooks_borrados', v_webhooks);
end $$;

-- Opt-out por HMAC (el HMAC se calcula en la edge function con HMAC_PEPPER; nunca en la BD).
create or replace function comunicacion.registrar_opt_out(p_hmac text, p_cliente uuid, p_origen text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  insert into comunicacion.opt_out (telefono_hmac, cliente_id, origen) values (p_hmac, p_cliente, p_origen)
  on conflict (telefono_hmac) do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

revoke all on function comunicacion.suprimir_lead(uuid), comunicacion.retencion_aplicar(timestamptz),
  comunicacion.registrar_opt_out(text, uuid, text) from public, anon, authenticated;
grant execute on function comunicacion.suprimir_lead(uuid), comunicacion.retencion_aplicar(timestamptz),
  comunicacion.registrar_opt_out(text, uuid, text) to service_role;
