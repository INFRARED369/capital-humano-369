-- =====================================================================
-- Integración (orquestador) · TRK-08: client_id y vacancy_id reales, derivados en el servidor.
-- El JSON de contenido (apps/web/vacantes/*.json → tracking.client_id) es texto ("telecom-mty"), no el UUID
-- de shared.clientes. El servidor ya no confía en el client_id del navegador: lo deriva de la vacante.
--  * shared.api_vacante_por_slug(ref): API pública del kernel (slug, id o código) → vacante y cliente.
--    Solo service_role (edge functions tracking-ingest y tracking-capi-worker).
--  * tracking.resolver_vacante usa la API. El cliente_ref solo lo pasan los eventos de servidor (outbox,
--    confiables); la ingesta del navegador manda cliente_ref = null (src/domains/tracking/application/ingerir.ts).
-- =====================================================================

create or replace function shared.api_vacante_por_slug(p_ref text)
returns table (vacante_id uuid, cliente_id uuid, slug text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.cliente_id, v.slug from shared.vacantes v
  where p_ref is not null
    -- CASE (no AND): Postgres no garantiza el orden de evaluación y el cast fallaría con un slug.
    and (v.id = case when p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_ref::uuid end
         or v.slug = p_ref or v.codigo = p_ref)
  order by (v.slug = p_ref) desc
  limit 1
$$;
revoke execute on function shared.api_vacante_por_slug(text) from public, anon, authenticated;
grant execute on function shared.api_vacante_por_slug(text) to service_role;

create or replace function tracking.resolver_vacante(p_vacante_ref text, p_cliente_ref text)
returns table (vacante_id uuid, cliente_id uuid) language plpgsql stable security definer set search_path = '' as $$
begin
  return query select a.vacante_id, a.cliente_id from shared.api_vacante_por_slug(p_vacante_ref) a;
  if found then return; end if;
  -- Solo eventos de servidor (outbox) traen cliente_ref; el navegador nunca (TRK-08).
  if p_cliente_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return query select null::uuid, c.id from shared.clientes c where c.id = p_cliente_ref::uuid;
    if found then return; end if;
  end if;
  return query select null::uuid, '00000000-0000-0000-0000-000000000000'::uuid;
end $$;
