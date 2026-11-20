-- =====================================================================
-- Integración (orquestador) · captacion.leads sin PII para el panel.
-- Antes: `grant select on captacion.leads to authenticated` (TODAS las columnas, incluido el teléfono,
-- también para el rol cliente). Ahora:
--  * grants POR COLUMNA sin PII para authenticated (mismo patrón que tracking.eventos). La consulta
--    actual del panel (`id, folio, nombre_pila`) sigue funcionando sin cambios.
--  * vista captacion.api_leads_panel: nombre, teléfono y correo SOLO para admin y reclutador asignado
--    (shared.puede_operar_vacante); el rol cliente los ve en NULL. Respeta la vacante visible
--    (puede_ver_vacante) y el bloqueo de 30 días (solo admin, Política §1.2).
-- Nunca expuestos al panel: telefono_hmac, respuestas, atribucion, visitor_id, event_id.
-- =====================================================================

revoke select on captacion.leads from authenticated;
grant select (id, cliente_id, vacante_id, folio, nombre_pila, estado, cita_id, cita_inicio, verificado_en,
  postulado_en, anonimizado_en, consentimiento_version, consentido_en, creado_en, actualizado_en)
  on captacion.leads to authenticated;

-- security_barrier y sin security_invoker: corre con los privilegios del dueño (postgres) y el filtro
-- de visibilidad va en el WHERE (como dashboard.api_*). Las funciones del filtro usan auth.uid().
create or replace view captacion.api_leads_panel with (security_barrier = true) as
select l.id, l.cliente_id, l.vacante_id, l.folio, l.nombre_pila, l.estado, l.cita_id, l.cita_inicio, l.verificado_en, l.postulado_en,
       case when shared.puede_operar_vacante(l.vacante_id) then l.nombre end as nombre,
       case when shared.puede_operar_vacante(l.vacante_id) then l.telefono end as telefono,
       case when shared.puede_operar_vacante(l.vacante_id) then l.email end as email
from captacion.leads l
where l.anonimizado_en is null
  and shared.puede_ver_vacante(l.vacante_id)
  and (shared.es_admin() or not privacidad.api_lead_bloqueado(l.id));
comment on view captacion.api_leads_panel is
  'API pública para el panel: nombre/teléfono/correo solo para admin y reclutador asignado; el rol cliente los ve NULL. Respeta el bloqueo.';
revoke all on captacion.api_leads_panel from public, anon, authenticated;
grant select on captacion.api_leads_panel to authenticated, service_role;
