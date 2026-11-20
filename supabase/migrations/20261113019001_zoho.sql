-- =====================================================================
-- Citas · Zoho Calendar como capa de acceso (D8, D9, CIT-08, CIT-09)
-- Dueño: subdominio citas/zoho. Estado propio de la sincronización: NO depende
-- de la forma de citas.citas; se alimenta de eventos del outbox
-- (CitaConfirmada, CitaReprogramada, CitaCancelada).
-- =====================================================================

-- Lo que el sistema publicó (o debe publicar) en Zoho por cita.
create table citas.zoho_eventos (
  cita_id uuid primary key,
  cliente_id uuid not null references shared.clientes(id),
  vacante_id uuid not null references shared.vacantes(id),
  lead_id uuid,
  zoho_calendar_uid text,
  zoho_event_uid text,
  uid_propio text not null unique,
  -- pendiente: falta publicar/actualizar/borrar · sincronizado · error: dead letter
  -- sin_calendario: vacante sin zoho_calendar_uid (Z7) · borrado · reemplazado: el evento pasó a la cita reprogramada
  estado_sync text not null default 'pendiente'
    check (estado_sync in ('pendiente', 'sincronizado', 'error', 'sin_calendario', 'borrado', 'reemplazado')),
  -- true = el evento debe existir en Zoho; false = debe no existir
  vigente boolean not null default true,
  inicio timestamptz not null,
  fin timestamptz not null,
  folio text not null,
  nombre_pila text,
  intentos int not null default 0,
  ultimo_error text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  sincronizado_en timestamptz,
  check (fin > inicio)
);
create index zoho_eventos_vacante_inicio on citas.zoho_eventos (vacante_id, inicio);
create index zoho_eventos_lead on citas.zoho_eventos (lead_id) where lead_id is not null;
create index zoho_eventos_fin_activos on citas.zoho_eventos (fin) where estado_sync not in ('borrado', 'reemplazado');

-- Alertas operativas de la integración (NFR-OBS-01): drift, dead letter, configuración incompleta, auth.
create table citas.zoho_alertas (
  id bigint generated always as identity primary key,
  cliente_id uuid not null references shared.clientes(id),
  vacante_id uuid references shared.vacantes(id),
  cita_id uuid,
  tipo text not null check (tipo in ('ZOHO_DRIFT', 'ZOHO_DEAD_LETTER', 'ZOHO_CONFIG_INCOMPLETA', 'ZOHO_AUTH',
                                     'ZOHO_RECONCILIACION_ERROR', 'ZOHO_SIN_REGISTRO')),
  detalle jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now(),
  atendida_en timestamptz
);
create index zoho_alertas_vacante on citas.zoho_alertas (vacante_id, creado_en desc);
create index zoho_alertas_abiertas on citas.zoho_alertas (tipo, creado_en desc) where atendida_en is null;

alter table citas.zoho_eventos enable row level security;
alter table citas.zoho_alertas enable row level security;

-- Panel: solo lectura, por vacante. Escritura únicamente por service_role (worker / reconciliación).
revoke all on citas.zoho_eventos, citas.zoho_alertas from public, anon, authenticated;
grant select on citas.zoho_eventos, citas.zoho_alertas to authenticated;
grant all on citas.zoho_eventos, citas.zoho_alertas to service_role;
grant usage on all sequences in schema citas to service_role;

create policy zoho_eventos_lectura on citas.zoho_eventos for select to authenticated
  using (shared.puede_ver_vacante(vacante_id));
create policy zoho_alertas_lectura on citas.zoho_alertas for select to authenticated
  using (shared.es_admin() or (vacante_id is not null and shared.puede_ver_vacante(vacante_id)));
