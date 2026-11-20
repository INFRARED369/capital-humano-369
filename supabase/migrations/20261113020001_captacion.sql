-- =====================================================================
-- Captación (dueño: dominio captacion) · CAP-03..CAP-10, D4, D11, D12
-- Leads con folio, OTP de WhatsApp (solo hash), rate limit por teléfono/IP,
-- contactos B2B de la portada, RLS deny-by-default y funciones de privacidad.
-- Todos los timestamps de negocio los pasa la aplicación (Clock); los default now() son respaldo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Leads (candidatos). La PII es nullable SOLO para permitir la anonimización (R7).
-- ---------------------------------------------------------------------
create table captacion.leads (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references shared.clientes(id),
  vacante_id uuid not null references shared.vacantes(id),
  folio text not null unique check (folio ~ '^369-[A-HJ-NP-Z2-9]{6}$'),
  nombre text check (length(nombre) between 2 and 120),
  nombre_pila text check (length(nombre_pila) between 1 and 60),
  telefono text check (telefono ~ '^52[0-9]{10}$'),                 -- E.164 sin '+' (convención @shared/crypto)
  telefono_hmac text check (telefono_hmac ~ '^[0-9a-f]{64}$'),      -- HMAC(HMAC_PEPPER, telefono): deduplicación (NFR-SEG-04)
  email text check (length(email) <= 254),
  respuestas jsonb check (respuestas is null or (jsonb_typeof(respuestas) = 'object' and octet_length(respuestas::text) <= 8192)),
  consentimiento_version text not null check (length(consentimiento_version) between 1 and 32),
  consentido_en timestamptz not null,
  atribucion jsonb not null default '{}' check (jsonb_typeof(atribucion) = 'object' and octet_length(atribucion::text) <= 8192),
  visitor_id text check (length(visitor_id) <= 64),
  event_id uuid not null unique,                                    -- event_id de Lead generado en el navegador (TRK-05)
  estado text not null default 'pendiente_otp' check (estado in ('pendiente_otp', 'verificado', 'otp_bloqueado')),
  cita_id uuid,                                                     -- id de citas (sin FK entre schemas)
  cita_inicio timestamptz,
  verificado_en timestamptz,
  postulado_en timestamptz not null default now(),                  -- última postulación (alta o reutilización P5)
  anonimizado_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  constraint leads_pii_salvo_anonimizado check (
    anonimizado_en is not null
    or (nombre is not null and nombre_pila is not null and telefono is not null and telefono_hmac is not null and respuestas is not null)
  )
);
create index leads_dedupe on captacion.leads (vacante_id, telefono_hmac, postulado_en desc) where telefono_hmac is not null;
create index leads_sin_verificar on captacion.leads (postulado_en) where estado <> 'verificado' and anonimizado_en is null;
create index leads_cliente on captacion.leads (cliente_id);

-- ---------------------------------------------------------------------
-- OTP: solo el HMAC del código (O5). 10 min, ≤ 5 intentos, un solo vigente por lead.
-- ---------------------------------------------------------------------
create table captacion.otp (
  id uuid primary key,                                              -- lo genera la app: el hash se liga a este id
  cliente_id uuid not null,
  lead_id uuid not null references captacion.leads(id) on delete cascade,
  codigo_hash text not null check (codigo_hash ~ '^[0-9a-f]{64}$'),
  expira_en timestamptz not null,
  intentos smallint not null default 0 check (intentos between 0 and 5),
  estado text not null default 'vigente' check (estado in ('vigente', 'verificado', 'bloqueado', 'reemplazado', 'vencido')),
  creado_en timestamptz not null default now(),
  cerrado_en timestamptz
);
create unique index otp_un_vigente_por_lead on captacion.otp (lead_id) where estado = 'vigente';
create index otp_lead_reciente on captacion.otp (lead_id, creado_en desc);
create index otp_creado on captacion.otp (creado_en);

-- ---------------------------------------------------------------------
-- Registro para rate limit (3 códigos/h por teléfono, 10/h por IP; B2B 10/h por IP).
-- Solo HMAC de teléfono e IP; se borra a las 24 h.
-- ---------------------------------------------------------------------
create table captacion.envios_limitados (
  id bigint generated always as identity primary key,
  cliente_id uuid not null,
  tipo text not null check (tipo in ('otp', 'b2b')),
  telefono_hmac text check (telefono_hmac ~ '^[0-9a-f]{64}$'),
  ip_hmac text check (ip_hmac ~ '^[0-9a-f]{64}$'),
  lead_id uuid references captacion.leads(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index envios_telefono on captacion.envios_limitados (tipo, telefono_hmac, creado_en) where telefono_hmac is not null;
create index envios_ip on captacion.envios_limitados (tipo, ip_hmac, creado_en) where ip_hmac is not null;
create index envios_creado on captacion.envios_limitados (creado_en);

-- ---------------------------------------------------------------------
-- Contactos B2B de la portada (CAP-09). Pertenecen a 369 (tenant comercial fijo, sin FK).
-- ---------------------------------------------------------------------
create table captacion.contactos_b2b (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null default '00000000-0000-0000-0000-000000000369',
  nombre text check (length(nombre) between 2 and 120),
  empresa text check (length(empresa) between 1 and 160),
  email text check (length(email) <= 254),
  servicio text not null check (length(servicio) <= 80),
  mensaje text check (length(mensaje) <= 2000),
  consentimiento_version text not null,
  consentido_en timestamptz not null,
  anonimizado_en timestamptz,
  creado_en timestamptz not null default now(),
  constraint b2b_pii_salvo_anonimizado check (anonimizado_en is not null or (nombre is not null and empresa is not null and email is not null))
);
create index contactos_b2b_creado on captacion.contactos_b2b (creado_en);

-- ---------------------------------------------------------------------
-- RLS: anon nada; panel solo lectura por vacante (leads) o admin (B2B). OTP y rate limit: sin acceso del panel.
-- ---------------------------------------------------------------------
alter table captacion.leads enable row level security;
alter table captacion.otp enable row level security;
alter table captacion.envios_limitados enable row level security;
alter table captacion.contactos_b2b enable row level security;

revoke all on captacion.leads, captacion.otp, captacion.envios_limitados, captacion.contactos_b2b from public, anon, authenticated;
grant select on captacion.leads, captacion.contactos_b2b to authenticated;
create policy leads_lectura_panel on captacion.leads for select to authenticated using (shared.puede_ver_vacante(vacante_id));
create policy b2b_lectura_admin on captacion.contactos_b2b for select to authenticated using (shared.es_admin());

grant all on captacion.leads, captacion.otp, captacion.envios_limitados, captacion.contactos_b2b to service_role;
grant usage, select on all sequences in schema captacion to service_role;

-- ---------------------------------------------------------------------
-- Privacidad (CONTRATOS §8). Idempotentes; devuelven conteos sin datos personales.
-- ---------------------------------------------------------------------

-- Supresión total del lead en captacion (ARCO/revocación R6 y lead sin verificar R1).
create or replace function captacion.suprimir_lead(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_hmac text; n_otp int; n_env int; n_lead int;
begin
  select telefono_hmac into v_hmac from captacion.leads where id = p_lead for update;
  delete from captacion.otp where lead_id = p_lead;
  get diagnostics n_otp = row_count;
  delete from captacion.envios_limitados where lead_id = p_lead or (v_hmac is not null and telefono_hmac = v_hmac);
  get diagnostics n_env = row_count;
  delete from captacion.leads where id = p_lead;
  get diagnostics n_lead = row_count;
  return jsonb_build_object('leads', n_lead, 'otp', n_otp, 'envios', n_env);
end $$;

-- Anonimización irreversible (R3/R7): quedan vacante, fechas, estado, folio y origen de campaña.
create or replace function captacion.anonimizar_lead(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_hmac text; n_lead int; n_otp int; n_env int;
begin
  select telefono_hmac into v_hmac from captacion.leads where id = p_lead for update;
  update captacion.leads set
    nombre = null, nombre_pila = null, telefono = null, telefono_hmac = null, email = null, respuestas = null, visitor_id = null,
    atribucion = atribucion - array['visitor_id', 'fbclid', 'gclid', 'fbc', 'fbp', 'referrer', 'landing'],
    anonimizado_en = now(), actualizado_en = now()
  where id = p_lead and anonimizado_en is null;
  get diagnostics n_lead = row_count;
  delete from captacion.otp where lead_id = p_lead;
  get diagnostics n_otp = row_count;
  delete from captacion.envios_limitados where lead_id = p_lead or (v_hmac is not null and telefono_hmac = v_hmac);
  get diagnostics n_env = row_count;
  return jsonb_build_object('leads', n_lead, 'otp', n_otp, 'envios', n_env);
end $$;

-- Reglas de la Política de retención que viven en captacion. En lotes (1000) e idempotente.
--   lead sin verificar WhatsApp: 48 h desde la última postulación → supresión total + LeadSuprimido (citas libera, comunicación cancela)
--   código OTP: se borra a las 24 h · registros de rate limit: 24 h
--   contactos B2B: anonimización a los 180 días (propuesta; la política no lo cubre aún)
create or replace function captacion.retencion_aplicar(p_ahora timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; n_leads int := 0; n_otp int; n_env int; n_b2b int;
begin
  for r in
    select id, vacante_id, cliente_id from captacion.leads
    where estado <> 'verificado' and anonimizado_en is null and postulado_en < p_ahora - interval '48 hours'
    order by postulado_en limit 1000 for update skip locked
  loop
    perform shared.publicar_evento('LeadSuprimido',
      jsonb_build_object('lead_id', r.id, 'vacante_id', r.vacante_id, 'cliente_id', r.cliente_id, 'regla', 'lead_sin_verificar_48h'), r.cliente_id);
    perform captacion.suprimir_lead(r.id);
    n_leads := n_leads + 1;
  end loop;

  delete from captacion.otp where id in (select id from captacion.otp where creado_en < p_ahora - interval '24 hours' limit 5000);
  get diagnostics n_otp = row_count;
  delete from captacion.envios_limitados where id in (select id from captacion.envios_limitados where creado_en < p_ahora - interval '24 hours' limit 5000);
  get diagnostics n_env = row_count;

  update captacion.contactos_b2b set nombre = null, empresa = null, email = null, mensaje = null, anonimizado_en = p_ahora
  where id in (select id from captacion.contactos_b2b where anonimizado_en is null and creado_en < p_ahora - interval '180 days' limit 1000);
  get diagnostics n_b2b = row_count;

  return jsonb_build_object('leads_sin_verificar_48h', n_leads, 'otp_24h', n_otp, 'envios_24h', n_env, 'contactos_b2b_180d', n_b2b);
end $$;

revoke all on function captacion.suprimir_lead(uuid), captacion.anonimizar_lead(uuid), captacion.retencion_aplicar(timestamptz) from public, anon, authenticated;
grant execute on function captacion.suprimir_lead(uuid), captacion.anonimizar_lead(uuid), captacion.retencion_aplicar(timestamptz) to service_role;
