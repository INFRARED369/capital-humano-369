-- pgTAP · Cierre backend (Postgres real): fallar_definitivo, alertas (NFR-OBS-01), rate limit por lotes,
-- geo de tracking (TRK-07) y caché del token de Zoho. Permisos, RLS, cron y comportamiento básico.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(39);

-- Funciones nuevas: solo service_role (10 × 3 = 30)
select ok(has_function_privilege(r, f, 'execute') = (r = 'service_role'),
          case when r = 'service_role' then 'service_role ejecuta ' else r || ' no ejecuta ' end || f)
from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array[
  'shared.fallar_definitivo(bigint,text)',
  'shared.evaluar_alertas(timestamptz,jsonb)',
  'shared.alertas_pendientes(integer)',
  'shared.alertas_marcar(bigint[],boolean,text)',
  'shared.rate_limit_sumar(text[],integer[],integer,timestamptz)',
  'tracking.eventos_sin_geo(integer)',
  'tracking.fijar_geo(jsonb)',
  'captacion.api_metricas_otp(timestamptz,timestamptz)',
  'citas.api_zoho_alertas_desde(text,bigint)',
  'privacidad.api_ultima_retencion()'
]) f;

-- RLS y grants de las tablas nuevas
select ok((select relrowsecurity from pg_class where oid = 'shared.alertas'::regclass), 'shared.alertas con RLS');
select ok((select relrowsecurity from pg_class where oid = 'citas.zoho_token_cache'::regclass), 'citas.zoho_token_cache con RLS');
select ok(not has_table_privilege('anon', 'shared.alertas', 'select'), 'anon no lee shared.alertas');
select ok(not has_table_privilege('authenticated', 'citas.zoho_token_cache', 'select'), 'authenticated no lee el token de Zoho');

-- Cron de alertas cada 5 min
select is((select schedule from cron.job where jobname = 'alertas'), '*/5 * * * *', 'cron alertas programado cada 5 min');

-- Comportamiento en Postgres real
insert into shared.cola (cola, payload, llave_idempotencia, estado) values ('pgtap-cierre', '{}', 'k', 'en_proceso');
select is(shared.fallar_definitivo((select id from shared.cola where cola = 'pgtap-cierre'), 'HTTP 400'), 'dead_letter', 'fallar_definitivo → dead_letter al 1.er intento');
select is((select count(*)::int from shared.dead_letter where cola = 'pgtap-cierre'), 1, 'una fila en dead_letter');
select ok((shared.evaluar_alertas(now(), '{}') ->> 'nuevas')::int >= 1, 'evaluar_alertas detecta la dead letter nueva');
select is((select sum(conteo)::int from shared.rate_limit_sumar(array['pgtap:a', 'pgtap:a'], array[3, 4], 60)), 7, 'rate_limit_sumar agrega por llave');

select * from finish();
rollback;
