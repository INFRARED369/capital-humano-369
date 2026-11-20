-- =====================================================================
-- Cierre backend · Zoho: caché del access token compartida entre isolates (bitácora zoho, pendiente 3).
-- Zoho limita los access tokens por refresh token (~10 cada 10 min); con crons cada minuto y arranques en
-- frío, la caché en memoria por isolate podía rozar el límite. Una sola fila, token CIFRADO (AES-GCM,
-- llave derivada de ZOHO_CLIENT_SECRET en la función). Sin políticas: solo service_role.
-- =====================================================================
create table citas.zoho_token_cache (
  id smallint primary key check (id = 1),
  token_cifrado text not null check (token_cifrado ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$' and length(token_cifrado) <= 2048),
  vence_en timestamptz not null,
  actualizado_en timestamptz not null default now()
);
alter table citas.zoho_token_cache enable row level security;
revoke all on citas.zoho_token_cache from public, anon, authenticated;
grant all on citas.zoho_token_cache to service_role;
