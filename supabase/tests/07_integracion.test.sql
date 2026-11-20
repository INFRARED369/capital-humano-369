-- pgTAP · Integración (orquestador) con roles y auth.uid() reales de Supabase.
--  * captacion.leads sin PII para el panel; api_leads_panel solo da nombre/teléfono a admin y reclutador.
--  * shared.api_vacante_por_slug (TRK-08) solo service_role.
--  * privacidad: LeadContratado → etapas contratado/entregado; dashboard en el orquestador.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(19);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000007a1', 'reclutador-a@int.test'),
  ('00000000-0000-4000-8000-0000000007c1', 'cliente-a@int.test'),
  ('00000000-0000-4000-8000-0000000007ad', 'admin@int.test');
insert into shared.clientes (id, nombre) values ('10000000-0000-4000-8000-00000000070a', 'Cliente A');
insert into shared.vacantes (id, cliente_id, slug, codigo, nombre) values
  ('20000000-0000-4000-8000-00000000070a', '10000000-0000-4000-8000-00000000070a', 'int-a', 'INT-A', 'Vacante A');
insert into shared.usuarios_roles (user_id, rol, cliente_id) values
  ('00000000-0000-4000-8000-0000000007a1', 'reclutador', '10000000-0000-4000-8000-00000000070a'),
  ('00000000-0000-4000-8000-0000000007c1', 'cliente', '10000000-0000-4000-8000-00000000070a'),
  ('00000000-0000-4000-8000-0000000007ad', 'admin', null);
insert into shared.usuarios_vacantes (user_id, vacante_id, cliente_id) values
  ('00000000-0000-4000-8000-0000000007a1', '20000000-0000-4000-8000-00000000070a', '10000000-0000-4000-8000-00000000070a'),
  ('00000000-0000-4000-8000-0000000007c1', '20000000-0000-4000-8000-00000000070a', '10000000-0000-4000-8000-00000000070a');
insert into captacion.leads (id, cliente_id, vacante_id, folio, nombre, nombre_pila, telefono, telefono_hmac, email, respuestas,
  consentimiento_version, consentido_en, event_id, estado)
values ('30000000-0000-4000-8000-00000000070a', '10000000-0000-4000-8000-00000000070a', '20000000-0000-4000-8000-00000000070a',
  '369-ABCDEF', 'Ana López', 'Ana', '528112345678', repeat('a', 64), 'ana@x.mx', '{}', '2026-11-13', now(), gen_random_uuid(), 'verificado');

-- ---------------------------------------------------------------------
-- PII por rol (captacion.leads / captacion.api_leads_panel)
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000007c1","role":"authenticated"}';
select throws_ok($$select telefono from captacion.leads$$, '42501', null, 'rol cliente: no lee el teléfono de captacion.leads');
select throws_ok($$select nombre from captacion.leads$$, '42501', null, 'rol cliente: no lee el nombre completo');
select throws_ok($$select * from captacion.leads$$, '42501', null, 'rol cliente: select * denegado (grants por columna)');
select is((select folio from captacion.leads), '369-ABCDEF', 'rol cliente: la consulta del panel (id, folio, nombre_pila) sigue funcionando');
select is((select telefono from captacion.api_leads_panel), null, 'rol cliente: api_leads_panel no muestra el teléfono');
select is((select nombre from captacion.api_leads_panel), null, 'rol cliente: api_leads_panel no muestra el nombre');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000007a1","role":"authenticated"}';
select throws_ok($$select telefono from captacion.leads$$, '42501', null, 'reclutador: tampoco lee PII directo de la tabla');
select is((select telefono from captacion.api_leads_panel), '528112345678', 'reclutador asignado: ve el teléfono en api_leads_panel');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000007ad","role":"authenticated"}';
select is((select nombre from captacion.api_leads_panel), 'Ana López', 'admin: ve el nombre en api_leads_panel');
reset role;

set local role anon;
select throws_ok($$select * from captacion.api_leads_panel$$, '42501', null, 'anon: sin acceso a api_leads_panel');
reset role;

-- ---------------------------------------------------------------------
-- TRK-08 · shared.api_vacante_por_slug
-- ---------------------------------------------------------------------
select is((select cliente_id from shared.api_vacante_por_slug('int-a')), '10000000-0000-4000-8000-00000000070a'::uuid, 'api_vacante_por_slug: slug → cliente real');
select ok(not has_function_privilege('authenticated', 'shared.api_vacante_por_slug(text)', 'execute'), 'api_vacante_por_slug: authenticated no la ejecuta');
select ok(has_function_privilege('service_role', 'shared.api_vacante_por_slug(text)', 'execute'), 'api_vacante_por_slug: service_role sí');

-- ---------------------------------------------------------------------
-- Privacidad · LeadContratado y dashboard en el orquestador
-- ---------------------------------------------------------------------
select is(privacidad.dominios(), array['captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'shared'], 'orquestador: incluye dashboard y shared');
select ok(not has_function_privilege('authenticated', 'dashboard.suprimir_lead(uuid)', 'execute'), 'dashboard.suprimir_lead: solo service_role');

insert into shared.outbox (tipo, payload, cliente_id, creado_en) values
  ('LeadContratado', jsonb_build_object('lead_id', '30000000-0000-4000-8000-00000000070a', 'vacante_id', '20000000-0000-4000-8000-00000000070a',
     'cliente_id', '10000000-0000-4000-8000-00000000070a', 'cita_id', null, 'entregado_en', null, 'event_id', gen_random_uuid()),
   '10000000-0000-4000-8000-00000000070a', now() - interval '5 days');
set local role service_role;
select ok((privacidad.retencion_diaria(now()) -> 'dominios') ? 'dashboard', 'retencion_diaria corre dashboard.retencion_aplicar como service_role');
reset role;
select is((select etapa from privacidad.ciclo_vida where lead_id = '30000000-0000-4000-8000-00000000070a'), 'contratado', 'LeadContratado sin entrega → etapa contratado');

insert into shared.outbox (tipo, payload, cliente_id) values
  ('LeadContratado', jsonb_build_object('lead_id', '30000000-0000-4000-8000-00000000070a', 'vacante_id', '20000000-0000-4000-8000-00000000070a',
     'cliente_id', '10000000-0000-4000-8000-00000000070a', 'cita_id', null, 'entregado_en', to_char(now() - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     'event_id', gen_random_uuid()), '10000000-0000-4000-8000-00000000070a');
set local role service_role;
select lives_ok($$select privacidad.retencion_diaria(now() + interval '1 second')$$, 'segunda corrida (entrega)');
reset role;
select is((select etapa from privacidad.ciclo_vida where lead_id = '30000000-0000-4000-8000-00000000070a'), 'entregado', 'con entregado_en → etapa entregado (bloqueo inmediato)');

select * from finish();
rollback;
