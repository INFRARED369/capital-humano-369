-- pgTAP · NFR-SEG-01 / S2 sobre Postgres REAL de Supabase (complementa supabase/tests/*.db.test.ts en PGlite).
-- Correr: npm run test:pgtap  (requiere `supabase start`). Dueño: plataforma.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(7);

create temp table _tablas on commit drop as
  select n.nspname as esquema, c.relname as tabla, c.oid, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and not c.relispartition
    and n.nspname in ('shared', 'config', 'captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'privacidad');
grant select on _tablas to anon, authenticated;

select cmp_ok((select count(*) from _tablas)::int, '>', 0, 'hay tablas de dominio');

select is(
  (select coalesce(array_agg(esquema || '.' || tabla order by 1), '{}') from _tablas where not rls),
  '{}'::text[], 'toda tabla de dominio tiene RLS habilitado');

select is(
  (select coalesce(array_agg(esquema || '.' || tabla order by 1), '{}') from _tablas
    where has_table_privilege('anon', oid, 'SELECT') or has_table_privilege('anon', oid, 'INSERT')
       or has_table_privilege('anon', oid, 'UPDATE') or has_table_privilege('anon', oid, 'DELETE')),
  '{}'::text[], 'S2: anon no tiene privilegios sobre ninguna tabla de dominio');

select is(
  (select coalesce(array_agg(n order by n), '{}') from unnest(array['shared','config','captacion','citas','comunicacion','tracking','dashboard','privacidad']) n
    where has_schema_privilege('anon', n, 'USAGE')),
  '{}'::text[], 'S2: anon no tiene USAGE en los schemas de dominio');

select is(
  (select coalesce(array_agg(esquema || '.' || tabla order by 1), '{}') from _tablas
    where has_table_privilege('authenticated', oid, 'INSERT') or has_table_privilege('authenticated', oid, 'UPDATE')
       or has_table_privilege('authenticated', oid, 'DELETE')),
  '{}'::text[], 'el panel (authenticated) no escribe tablas directamente: solo funciones security definer');

select is(
  (select coalesce(array_agg(n.nspname || '.' || p.proname order by 1), '{}')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('shared', 'config', 'captacion', 'citas', 'comunicacion', 'tracking', 'dashboard', 'privacidad')
      and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  '{}'::text[], 'toda función security definer fija search_path');

-- Prueba dinámica: como anon, consultar cada tabla falla con permiso denegado (42501).
create function pg_temp.lee(p_esquema text, p_tabla text) returns boolean language plpgsql as $$
begin
  execute format('select 1 from %I.%I limit 1', p_esquema, p_tabla);
  return true;
exception when insufficient_privilege then
  return false;
end $$;
set local role anon;
select is(
  (select coalesce(array_agg(t.esquema || '.' || t.tabla order by 1), '{}') from _tablas t where pg_temp.lee(t.esquema, t.tabla)),
  '{}'::text[], 'S2: anon recibe permiso denegado al consultar cada tabla');
reset role;

select * from finish();
rollback;
