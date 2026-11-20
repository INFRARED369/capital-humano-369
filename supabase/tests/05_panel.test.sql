-- pgTAP · Panel (dueño: vacantes/panel/dashboard) con roles y auth.uid() reales de Supabase.
-- S3 (cliente no edita reglas), S4 / NFR-SEG-09 (versión inmutable + auditoría con quién, cuándo y diff),
-- S1 / DSH-06 sobre las vistas del dashboard y refresco de las vistas materializadas como su dueño.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000005a1', 'reclutador-a@panel.test'),
  ('00000000-0000-4000-8000-0000000005c1', 'cliente-a@panel.test'),
  ('00000000-0000-4000-8000-0000000005b1', 'cliente-b@panel.test'),
  ('00000000-0000-4000-8000-0000000005ad', 'admin@panel.test');
insert into shared.clientes (id, nombre) values
  ('10000000-0000-4000-8000-00000000050a', 'Cliente A'),
  ('10000000-0000-4000-8000-00000000050b', 'Cliente B');
insert into shared.vacantes (id, cliente_id, slug, codigo, nombre) values
  ('20000000-0000-4000-8000-00000000050a', '10000000-0000-4000-8000-00000000050a', 'panel-a', 'PANEL-A', 'Vacante A'),
  ('20000000-0000-4000-8000-00000000050b', '10000000-0000-4000-8000-00000000050b', 'panel-b', 'PANEL-B', 'Vacante B');
insert into shared.usuarios_roles (user_id, rol, cliente_id) values
  ('00000000-0000-4000-8000-0000000005a1', 'reclutador', '10000000-0000-4000-8000-00000000050a'),
  ('00000000-0000-4000-8000-0000000005c1', 'cliente', '10000000-0000-4000-8000-00000000050a'),
  ('00000000-0000-4000-8000-0000000005b1', 'cliente', '10000000-0000-4000-8000-00000000050b'),
  ('00000000-0000-4000-8000-0000000005ad', 'admin', null);
insert into shared.usuarios_vacantes (user_id, vacante_id, cliente_id) values
  ('00000000-0000-4000-8000-0000000005a1', '20000000-0000-4000-8000-00000000050a', '10000000-0000-4000-8000-00000000050a'),
  ('00000000-0000-4000-8000-0000000005c1', '20000000-0000-4000-8000-00000000050a', '10000000-0000-4000-8000-00000000050a'),
  ('00000000-0000-4000-8000-0000000005b1', '20000000-0000-4000-8000-00000000050b', '10000000-0000-4000-8000-00000000050b');

-- ---------------------------------------------------------------------
-- S3 · el rol cliente no edita reglas (ni por PostgREST ni con su identidad en la función)
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005c1","role":"authenticated"}';
select throws_ok($$select config.guardar_reglas('20000000-0000-4000-8000-00000000050a', '{}'::jsonb, 0)$$, '42501', 'permission denied for function guardar_reglas',
  'S3: authenticated no puede ejecutar config.guardar_reglas (solo la edge function con Zod)');
select throws_ok($$insert into config.vacantes_reglas (vacante_id, version, cliente_id, reglas) values ('20000000-0000-4000-8000-00000000050a', 1, '10000000-0000-4000-8000-00000000050a', '{}')$$,
  '42501', null, 'S3: el panel no escribe config.vacantes_reglas directamente');
select throws_ok($$insert into config.vacantes_reglas_auditoria (vacante_id, cliente_id, version, diff) values ('20000000-0000-4000-8000-00000000050a', '10000000-0000-4000-8000-00000000050a', 1, '[]')$$,
  '42501', null, 'S4: nadie inserta auditoría a mano');
reset role;

-- Ruta de la edge function: conexión de servicio + claims del usuario verificado.
set local role service_role;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005c1","role":"authenticated"}';
select throws_ok($$select config.guardar_reglas('20000000-0000-4000-8000-00000000050a', '{}'::jsonb, 0)$$, '42501', 'PERMISO_DENEGADO',
  'S3: con la identidad del rol cliente, guardar_reglas se deniega');
select throws_ok($$select config.crear_vacante('10000000-0000-4000-8000-00000000050a', 'x-y', 'XY', 'x')$$, '42501', 'PERMISO_DENEGADO',
  'NFR-ESC-06: el cliente no da de alta vacantes');

-- Reclutador de A: no edita B ni cambia el calendario de Zoho.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005a1","role":"authenticated"}';
select throws_ok($$select config.guardar_reglas('20000000-0000-4000-8000-00000000050b', '{}'::jsonb, 0)$$, '42501', 'PERMISO_DENEGADO', 'S1: reclutador de A no edita B');
select throws_ok($$select config.guardar_reglas('20000000-0000-4000-8000-00000000050a', '{"zoho_calendar_uid":"calendario-propio"}'::jsonb, 0)$$, '42501', 'PERMISO_DENEGADO',
  'solo admin cambia el calendario de Zoho');
select throws_ok($$select config.guardar_reglas('20000000-0000-4000-8000-00000000050a', '{"desconocido":1}'::jsonb, 0)$$, '22023', 'REGLAS_INVALIDAS', 'validación mínima en SQL');

-- ---------------------------------------------------------------------
-- S4 · versión nueva inmutable + auditoría con quién, cuándo y diff
-- ---------------------------------------------------------------------
select is((config.guardar_reglas('20000000-0000-4000-8000-00000000050a', '{"agenda":{"cupo_diario":10}}'::jsonb, 0) ->> 'version')::int, 1,
  'reclutador asignado crea la versión 1');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005ad","role":"authenticated"}';
select is((config.guardar_reglas('20000000-0000-4000-8000-00000000050a', '{"agenda":{"cupo_diario":5},"zoho_calendar_uid":"calendario-a1"}'::jsonb, 1) ->> 'version')::int, 2,
  'admin crea la versión 2 (con calendario)');
select throws_ok($$select config.guardar_reglas('20000000-0000-4000-8000-00000000050a', '{"agenda":{"cupo_diario":3}}'::jsonb, 1)$$, '40001', 'VERSION_CONFLICTO',
  'control optimista: versión base vieja');
reset role;

select results_eq(
  $$select version, usuario_id from config.vacantes_reglas_auditoria where vacante_id = '20000000-0000-4000-8000-00000000050a' order by id$$,
  $$values (1, '00000000-0000-4000-8000-0000000005a1'::uuid), (2, '00000000-0000-4000-8000-0000000005ad'::uuid)$$,
  'S4: auditoría con la versión y el usuario de cada cambio');
select is((select diff from config.vacantes_reglas_auditoria where vacante_id = '20000000-0000-4000-8000-00000000050a' and version = 2),
  '[{"ruta":"agenda.cupo_diario","antes":10,"despues":5},{"ruta":"zoho_calendar_uid","antes":null,"despues":"calendario-a1"}]'::jsonb,
  'S4: el diff registra ruta, antes y después');
select ok((select creado_en from config.vacantes_reglas_auditoria where vacante_id = '20000000-0000-4000-8000-00000000050a' and version = 2) is not null, 'S4: queda el cuándo');
select throws_ok($$update config.vacantes_reglas_auditoria set diff = '[]' where vacante_id = '20000000-0000-4000-8000-00000000050a'$$, null, 'La auditoría de reglas es inmutable',
  'S4: la auditoría es append-only (ni el dueño la reescribe)');
select throws_ok($$update config.vacantes_reglas set reglas = '{}' where vacante_id = '20000000-0000-4000-8000-00000000050a'$$, null, 'Las versiones de reglas son inmutables',
  'C13: las versiones son inmutables');

-- Historial para el panel (S1): el cliente de B no ve el historial de A.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005b1","role":"authenticated"}';
select is((select count(*)::int from config.historial_reglas('20000000-0000-4000-8000-00000000050a')), 0, 'S1: cliente de B no ve el historial de A');
reset role;

-- ---------------------------------------------------------------------
-- S1 / DSH-06 · dashboard: vistas materializadas refrescadas como su dueño, expuestas filtradas
-- ---------------------------------------------------------------------
select tracking.registrar_evento(jsonb_build_object('event_id', gen_random_uuid(), 'nombre', 'LeadCreado', 'fuente', 'servidor', 'consentimiento', true,
  'vacante_ref', '20000000-0000-4000-8000-00000000050a', 'origen', 'meta_pagado', 'utm_campaign', 'camp-a'), '{}');
select tracking.registrar_evento(jsonb_build_object('event_id', gen_random_uuid(), 'nombre', 'LeadCreado', 'fuente', 'servidor', 'consentimiento', true,
  'vacante_ref', '20000000-0000-4000-8000-00000000050b', 'origen', 'directo'), '{}');
select dashboard.refrescar();

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005a1","role":"authenticated"}';
select results_eq($$select distinct vacante_id from dashboard.api_kpis_diarios where vacante_id in ('20000000-0000-4000-8000-00000000050a', '20000000-0000-4000-8000-00000000050b')$$,
  $$values ('20000000-0000-4000-8000-00000000050a'::uuid)$$, 'S1: reclutador de A solo ve KPIs de A');
select throws_ok($$select * from dashboard.mv_kpis_diarios$$, '42501', null, 'S1: la vista materializada no se lee directamente');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005b1","role":"authenticated"}';
select results_eq($$select distinct vacante_id from dashboard.api_funnel where vacante_id in ('20000000-0000-4000-8000-00000000050a', '20000000-0000-4000-8000-00000000050b')$$,
  $$values ('20000000-0000-4000-8000-00000000050b'::uuid)$$, 'S1: cliente de B solo ve el funnel de B');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000005ad","role":"authenticated"}';
select is((select count(distinct vacante_id)::int from dashboard.api_kpis_diarios where vacante_id in ('20000000-0000-4000-8000-00000000050a', '20000000-0000-4000-8000-00000000050b')), 2,
  'el refresco (dueño) ve todos los tenants y el admin ve ambas vacantes');
reset role;

set local role anon;
select throws_ok($$select * from dashboard.api_kpis_diarios$$, '42501', null, 'S2: anon no lee el dashboard');
reset role;

select * from finish();
rollback;
