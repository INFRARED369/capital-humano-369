-- pgTAP · Privacidad con roles reales de Supabase (auth.uid() real).
--  * R7: el lead anonimizado por la corrida diaria queda con nombre, teléfono, email y respuestas en NULL.
--  * Solo service_role ejecuta las funciones de supresión/retención (de TODOS los dominios); anon y
--    authenticated no, aunque sean admin.
--  * PRV-03: el registro de supresiones rechaza datos personales.
--  * RLS: solicitudes ARCO y registro solo para admin.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(54);

-- Datos: cliente, vacante, admin y reclutador; un lead verificado hace 100 días sin cita (agenda por WhatsApp).
insert into shared.clientes (id, nombre) values ('10000000-0000-4000-8000-0000000000c6', 'Cliente privacidad');
insert into shared.vacantes (id, cliente_id, slug, codigo, nombre)
values ('20000000-0000-4000-8000-0000000000c6', '10000000-0000-4000-8000-0000000000c6', 'pgtap-privacidad', 'PGTAP-PRIV', 'Vacante privacidad');
insert into shared.usuarios_roles (user_id, rol, cliente_id) values
  ('00000000-0000-4000-8000-0000000006ad', 'admin', null),
  ('00000000-0000-4000-8000-0000000006a1', 'reclutador', '10000000-0000-4000-8000-0000000000c6');
insert into shared.usuarios_vacantes (user_id, vacante_id, cliente_id)
values ('00000000-0000-4000-8000-0000000006a1', '20000000-0000-4000-8000-0000000000c6', '10000000-0000-4000-8000-0000000000c6');

insert into captacion.leads (id, cliente_id, vacante_id, folio, nombre, nombre_pila, telefono, telefono_hmac, email, respuestas,
  consentimiento_version, consentido_en, atribucion, visitor_id, event_id, estado, verificado_en, postulado_en, creado_en, actualizado_en)
values ('30000000-0000-4000-8000-0000000000c6', '10000000-0000-4000-8000-0000000000c6', '20000000-0000-4000-8000-0000000000c6',
  '369-PGTAP6', 'mariana garza', 'Mariana', '528112345678', repeat('a', 64), 'mariana@correo.mx', '{"edad": 22}',
  '2026-11-13', now() - interval '100 days', '{"utm_source":"facebook","fbclid":"x"}', 'vis-1', gen_random_uuid(), 'verificado',
  now() - interval '100 days', now() - interval '100 days', now() - interval '100 days', now() - interval '100 days');
insert into shared.outbox (tipo, payload, cliente_id, creado_en) values
  ('LeadCreado', '{"lead_id":"30000000-0000-4000-8000-0000000000c6","vacante_id":"20000000-0000-4000-8000-0000000000c6","cliente_id":"10000000-0000-4000-8000-0000000000c6"}',
   '10000000-0000-4000-8000-0000000000c6', now() - interval '100 days'),
  ('WhatsAppVerificado', '{"lead_id":"30000000-0000-4000-8000-0000000000c6","vacante_id":"20000000-0000-4000-8000-0000000000c6","cliente_id":"10000000-0000-4000-8000-0000000000c6"}',
   '10000000-0000-4000-8000-0000000000c6', now() - interval '100 days');

-- ---------------------------------------------------------------------
-- Permisos: solo service_role (11 funciones × 3 roles = 33 pruebas)
-- ---------------------------------------------------------------------
select ok(has_function_privilege(r, f, 'execute') = (r = 'service_role'),
          case when r = 'service_role' then 'service_role ejecuta ' else r || ' no ejecuta ' end || f)
from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array[
  'privacidad.retencion_diaria(timestamptz,int)', 'privacidad.suprimir_lead(uuid)', 'privacidad.suprimir_lead(uuid,text)',
  'privacidad.arco_ejecutar(uuid,timestamptz)',
  'captacion.suprimir_lead(uuid)', 'captacion.retencion_aplicar(timestamptz)',
  'citas.suprimir_lead(uuid)', 'citas.zoho_suprimir_lead(uuid)',
  'comunicacion.suprimir_lead(uuid)', 'tracking.suprimir_lead(uuid)', 'tracking.retencion_aplicar(timestamptz)']) f
order by f, r;

-- El admin del panel tampoco puede suprimir directamente (lo hace la edge function arco con service_role).
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000006ad","role":"authenticated"}';
select throws_ok($$select privacidad.suprimir_lead('30000000-0000-4000-8000-0000000000c6'::uuid)$$, '42501', null, 'admin autenticado no ejecuta privacidad.suprimir_lead');
select throws_ok($$select captacion.suprimir_lead('30000000-0000-4000-8000-0000000000c6'::uuid)$$, '42501', null, 'admin autenticado no ejecuta captacion.suprimir_lead');
reset role;

-- ---------------------------------------------------------------------
-- R7 · la corrida diaria (como service_role) anonimiza el lead vencido
-- ---------------------------------------------------------------------
set local role service_role;
select ok((privacidad.retencion_diaria(now()) -> 'conteos' -> 'privacidad' ->> 'ciclo_anonimizados')::int = 1, 'retencion_diaria anonimiza 1 lead');
reset role;
select is((select nombre from captacion.leads where folio = '369-PGTAP6'), null, 'R7: nombre NULL');
select is((select telefono from captacion.leads where folio = '369-PGTAP6'), null, 'R7: teléfono NULL');
select is((select telefono_hmac from captacion.leads where folio = '369-PGTAP6'), null, 'R7: HMAC NULL');
select is((select email from captacion.leads where folio = '369-PGTAP6'), null, 'R7: email NULL');
select is((select respuestas from captacion.leads where folio = '369-PGTAP6'), null, 'R7: respuestas NULL');
select ok((select vacante_id is not null and estado is not null and anonimizado_en is not null and postulado_en is not null
           from captacion.leads where folio = '369-PGTAP6'), 'R7: quedan vacante, estado y fechas');
select is((select atribucion from captacion.leads where folio = '369-PGTAP6'), '{"utm_source":"facebook"}'::jsonb, 'R7: la atribución pierde los identificadores');
select is((select count(*)::int from privacidad.registro_supresiones where tipo = 'retencion'), 1, 'PRV-03: la corrida queda en el registro');

-- ---------------------------------------------------------------------
-- PRV-03 · el registro no admite datos personales
-- ---------------------------------------------------------------------
select throws_ok($$insert into privacidad.registro_supresiones (tipo, ejecutado_en, conteos) values ('retencion', now(), '{"telefono":"528112345678"}')$$,
  '23514', null, 'PRV-03: conteos con texto → CHECK');
select throws_ok($$insert into privacidad.registro_supresiones (tipo, ejecutado_en, reglas) values ('retencion', now(), array['borré a Mariana'])$$,
  '23514', null, 'PRV-03: reglas con texto libre → CHECK');

-- ---------------------------------------------------------------------
-- RLS: solicitudes ARCO y registro solo para admin; ciclo de vida para nadie del panel
-- ---------------------------------------------------------------------
select privacidad.arco_registrar('acceso', 'correo', repeat('b', 64), '{}'::uuid[], now(), current_date + 30, current_date + 50,
  '00000000-0000-4000-8000-0000000006ad'::uuid);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000006ad","role":"authenticated"}';
select is((select count(*)::int from privacidad.solicitudes_arco), 1, 'admin ve las solicitudes ARCO');
select is((select count(*)::int from privacidad.registro_supresiones), 1, 'admin ve el registro de supresiones');
select throws_ok($$update privacidad.solicitudes_arco set estado = 'ejecutada'$$, '42501', null, 'admin no escribe la tabla directamente');
select throws_ok($$select * from privacidad.ciclo_vida$$, '42501', null, 'el panel no lee ciclo_vida');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000006a1","role":"authenticated"}';
select is((select count(*)::int from privacidad.solicitudes_arco), 0, 'reclutador no ve solicitudes ARCO');
select is((select count(*)::int from privacidad.registro_supresiones), 0, 'reclutador no ve el registro');
select ok(not privacidad.api_lead_bloqueado('30000000-0000-4000-8000-0000000000c6'), 'el panel puede consultar api_lead_bloqueado');
reset role;
set local role anon;
select throws_ok($$select * from privacidad.solicitudes_arco$$, '42501', null, 'anon no lee solicitudes ARCO');
reset role;

select * from finish();
rollback;
