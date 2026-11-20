-- pgTAP · S1 (aislamiento por vacante/cliente) y S2 con roles reales de Supabase (auth.uid() real).
-- Usa solo tablas de la migración base para no acoplarse a los esquemas de otros dominios.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(9);

-- Datos: dos clientes, una vacante cada uno, reclutador de A, cliente de B y un admin.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'reclutador-a@e2e.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'cliente-b@e2e.test'),
  ('00000000-0000-4000-8000-0000000000ad', 'admin@e2e.test');
insert into shared.clientes (id, nombre) values
  ('10000000-0000-4000-8000-00000000000a', 'Cliente A'),
  ('10000000-0000-4000-8000-00000000000b', 'Cliente B');
insert into shared.vacantes (id, cliente_id, slug, codigo, nombre) values
  ('20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', 'pgtap-a', 'PGTAP-A', 'Vacante A'),
  ('20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', 'pgtap-b', 'PGTAP-B', 'Vacante B');
insert into shared.usuarios_roles (user_id, rol, cliente_id) values
  ('00000000-0000-4000-8000-0000000000a1', 'reclutador', '10000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-0000000000b1', 'cliente', '10000000-0000-4000-8000-00000000000b'),
  ('00000000-0000-4000-8000-0000000000ad', 'admin', null);
insert into shared.usuarios_vacantes (user_id, vacante_id, cliente_id) values
  ('00000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b');
insert into config.vacantes_reglas (vacante_id, version, cliente_id, reglas) values
  ('20000000-0000-4000-8000-00000000000a', 1, '10000000-0000-4000-8000-00000000000a', '{}'),
  ('20000000-0000-4000-8000-00000000000b', 1, '10000000-0000-4000-8000-00000000000b', '{}');

-- S1 · reclutador de A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select results_eq($$select slug from shared.vacantes where slug like 'pgtap-%' order by 1$$, array['pgtap-a'], 'S1: reclutador de A solo ve la vacante A');
select results_eq($$select v.slug from config.vacantes_reglas r join shared.vacantes v on v.id = r.vacante_id where v.slug like 'pgtap-%'$$, array['pgtap-a'], 'S1: reclutador de A solo ve las reglas de A');
select ok(shared.puede_operar_vacante('20000000-0000-4000-8000-00000000000a'), 'reclutador de A opera A');
select ok(not shared.puede_operar_vacante('20000000-0000-4000-8000-00000000000b'), 'S1: reclutador de A no opera B');
select throws_ok($$update shared.vacantes set nombre = 'x' where slug = 'pgtap-a'$$, '42501', null, 'el panel no escribe tablas directamente');

-- Cliente de B: lectura de su vacante, sin operar.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select results_eq($$select slug from shared.vacantes where slug like 'pgtap-%' order by 1$$, array['pgtap-b'], 'S1: cliente de B solo ve B');
select ok(not shared.puede_operar_vacante('20000000-0000-4000-8000-00000000000b'), 'S3: rol cliente no opera ni su propia vacante');

-- Admin ve ambas.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000ad","role":"authenticated"}';
select results_eq($$select slug from shared.vacantes where slug like 'pgtap-%' order by 1$$, array['pgtap-a', 'pgtap-b'], 'admin ve todas las vacantes');

-- S2 · anon
reset role;
set local role anon;
select throws_ok($$select * from shared.vacantes$$, '42501', null, 'S2: anon no lee shared.vacantes');
reset role;

select * from finish();
rollback;
