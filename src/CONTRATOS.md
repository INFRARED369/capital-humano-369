# Contratos entre dominios

Fuente de verdad del plan: `docs/Plan de acción TDD.md`. Este archivo fija **las interfaces entre dominios** para que cada uno se construya en paralelo. Si un dominio necesita cambiar un contrato, lo anota en su bitácora (`docs/bitacora/<dominio>.md`, sección "Cambios de contrato") y lo hace compatible hacia atrás.

## Estructura

```
src/shared/                 kernel: Clock, Result, ids (uuidv7), crypto (sha256/hmac/timingSafeEqual), logger con redacción, SqlClient, eventos de dominio, http
src/domains/<d>/
  domain/                   puro, sin I/O (cobertura ≥ 90 %)
  application/              casos de uso; dependen de puertos (cobertura ≥ 80 %)
  infra/                    adaptadores (SQL, HTTP de proveedores, handlers de edge functions)
  ui/                       componentes React del dominio (opcional)
  index.ts                  ÚNICA API pública del dominio
supabase/migrations/        <14 dígitos>_<nombre>.sql — bloque por dominio (ver abajo)
supabase/functions/<fn>/index.ts   cableado Deno (Deno.serve) → handler en src/domains/<d>/infra/http/
supabase/functions/_shared/        utilidades Deno (dueño: plataforma)
apps/web/                   Next.js export estático
test/db/harness.ts          PGlite con todas las migraciones (sustituye a Supabase local + pgTAP)
```

Bloques de migraciones: `00000000000000` base · `2026111301NNNN` citas (`20261113019NNN` zoho) · `2026111302NNNN` captacion · `2026111303NNNN` comunicacion · `2026111304NNNN` tracking · `2026111305NNNN` vacantes/panel/dashboard · `2026111306NNNN` privacidad.

## Reglas

1. Un dominio no lee ni escribe tablas de otro schema. Para cruzar usa el `index.ts` del otro dominio (TS) o una función/vista SQL pública de ese schema con prefijo `api_` (SQL).
2. Eventos entre dominios: `select shared.publicar_evento(tipo, payload, cliente_id, correlation_id)` en la MISMA transacción que el cambio. Tipos y payloads en `src/shared/eventos.ts`. Consumo: `shared.leer_outbox(consumidor, tipos[], n)` + `shared.avanzar_outbox(consumidor, ultimo_id)`.
3. Trabajo asíncrono: `shared.encolar(cola, payload, llave, prioridad, cliente_id, visible_desde, max_intentos)` · `shared.tomar(cola, n, vt)` · `shared.completar(id)` · `shared.fallar(id, error, backoff_seg)` → `'reintento' | 'dead_letter'` · `shared.fallar_definitivo(id, error)` (error permanente → dead letter inmediato). Prioridad 0 = más alta (OTP).
4. Toda tabla: `cliente_id uuid not null`, RLS habilitado, sin grants a `anon`. Lectura del panel con `shared.puede_ver_vacante(vacante_id)`; escritura del panel solo por funciones `security definer` que validan `shared.puede_operar_vacante` / `shared.es_admin()`.
5. Sin PII en outbox, logs, dataLayer, Pixel ni Zoho. Usar `crearLogger` de `@shared/logger`.
6. Las edge functions son handlers puros `(req: Request, deps) => Promise<Response>` probados en Node; `supabase/functions/<fn>/index.ts` solo arma dependencias reales.
7. Prohibido `innerHTML` / `dangerouslySetInnerHTML` (lint).
8. Cada dominio implementa en su schema, para Privacidad:
   - `<schema>.suprimir_lead(p_lead uuid) returns jsonb` — borra/anonimiza todo lo del lead en su schema; idempotente; devuelve conteos.
   - `<schema>.retencion_aplicar(p_ahora timestamptz) returns jsonb` — aplica sus filas de la [[Política de retención de datos]]; idempotente, en lotes; devuelve conteos por regla.

9. Imports con extensión explícita (`./x.ts`, `@shared/clock.ts`) en `src/` y `supabase/functions/`: el CLI de Supabase no resuelve imports sin extensión (guardia: `scripts/imports-deno.test.ts`).
10. TRK-08: el `client_id` del navegador se ignora; el servidor lo deriva de la vacante con `shared.api_vacante_por_slug(ref)` (solo `service_role`).

## API pública por dominio (TypeScript)

### citas (`src/domains/citas/index.ts`)
```ts
ReglasAgendaSchema, PLANTILLA_AGENDA_DEFECTO, type ReglasAgenda, type Slot
generarSlots(reglas, ocupacion, clock): Slot[]                  // puro
obtenerSlots(deps: { sql: SqlClient; clock: Clock }, vacanteId): Promise<Result<{ slots: Slot[]; reglasVersion: number; zonaHoraria: string }, 'VACANTE_NO_ENCONTRADA'>>
retenerSlot(tx: SqlClient, { vacanteId, leadId, inicio /* ISO UTC */ }, clock)
  : Promise<Result<{ citaId: string; expiraEn: string; reglasVersion: number }, 'SLOT_INVALIDO' | 'SLOT_LLENO' | 'CUPO_DIARIO' | 'VACANTE_NO_ENCONTRADA'>>
confirmarCita(tx, { citaId, folio, nombrePila, eventId }, clock)  // publica CitaConfirmada en la misma tx
  : Promise<Result<{ citaId: string; inicio: string; fin: string }, 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA'>>
liberarRetencion(tx, { citaId, motivo }): Promise<void>
extenderRetencion(tx, { citaId }, clock)   // reenvío de OTP: min(ahora + TTL, retención + 3 × TTL); nunca acorta
  : Promise<Result<{ citaId: string; expiraEn: string }, 'NO_ENCONTRADA' | 'EXPIRADA' | 'TRANSICION_INVALIDA'>>
firmarLinkGestion({ citaId, accion: 'cancelar' | 'reprogramar', expiraEn }, secreto): Promise<string>
```
SQL público: `citas.api_ocupacion_diaria` (vista: vacante_id, dia, retenidas, confirmadas, asistio, no_asistio, cupo) y `citas.registrar_asistencia(p_cita uuid, p_asistio boolean, p_evaluacion jsonb)` (security definer, valida `puede_operar_vacante`, publica `AsistenciaRegistrada`).

### captacion (`src/domains/captacion/index.ts`)
```ts
obtenerContactoLead(sql, leadId): Promise<{ telefonoE164: string; email: string | null; nombrePila: string; folio: string; visitorId: string | null; vacanteId: string; clienteId: string } | null>
// Puertos que consume (los implementan otros dominios y se cablean en supabase/functions/postular|verificar-otp):
interface AgendaPort { retener(tx, {vacanteId, leadId, inicio}); confirmar(tx, {citaId, folio, nombrePila, eventId}); liberar(tx, {citaId, motivo}); extender(tx, {citaId}) }   // = citas
interface MensajeriaPort { encolar(tx, SolicitudMensaje) }                                                            // = comunicacion.encolarMensaje
interface VerificadorWhatsAppPort { existeEnWhatsApp(telefonoE164): Promise<boolean> }                               // = comunicacion (Evolution)
```

### comunicacion (`src/domains/comunicacion/index.ts`)
```ts
type TipoMensaje = 'otp' | 'confirmacion' | 'recordatorio_24h' | 'recordatorio_2h' | 'cancelacion' | 'reprogramacion' | 'agradecimiento'
type SolicitudMensaje = { tipo: TipoMensaje; canal: 'whatsapp' | 'email' | 'sms'; leadId: string; vacanteId: string; clienteId: string;
                          llave: string; variables?: Record<string, string>; programadoPara?: string; codigoCifrado?: string }
encolarMensaje(tx, SolicitudMensaje): Promise<{ mensajeId: string }>          // otp → prioridad 0
cifrarCodigoOtp(codigo, claveBase64): Promise<string>                          // AES-GCM; el worker descifra al enviar y borra el cifrado al terminar
crearEvolutionAdapter(cfg, fetchImpl): WhatsAppPort & VerificadorWhatsAppPort
ReglasMensajesSchema, PLANTILLAS_DEFECTO
```
El destino (teléfono/correo) se resuelve AL ENVIAR con `captacion.obtenerContactoLead` (puerto `ContactosPort`); si el lead fue suprimido no se envía. La cola no guarda PII en claro. Publica `MensajeEnviado` (con costo) y `MensajeFallido`.

### tracking
- Navegador: `apps/web/lib/tracking/index.ts` → `track(nombre, props, eventId?)`, `obtenerAtribucion()`, `tieneConsentimiento()`, `fijarContextoVacante(ctx)`, `<ConsentBanner/>`, `<TrackingProvider/>` (en `apps/web/lib/tracking/`).
- Servidor: `src/domains/tracking/index.ts` → `clasificarOrigen(...)`, handler de `tracking-ingest`, consumidor del outbox (`LeadCreado`, `WhatsAppVerificado`, `CitaConfirmada`, `AsistenciaRegistrada`) → cola `tracking-capi` → CAPI/GA4 (Stape).
- `event_id` de `Lead` lo genera el navegador (UUID v7), viaja en el POST de postular y en `LeadCreado.event_id`.

### vacantes (`src/domains/vacantes/index.ts`, wave 2)
Esquema compuesto `ReglasVacanteSchema = { agenda: ReglasAgendaSchema, mensajes: ReglasMensajesSchema, zoho_calendar_uid?: string, ventana_contacto, ... }` y `config.guardar_reglas(...)` con auditoría (S4).

## Configuración de entorno (edge functions; nunca en el frontend)
`SUPABASE_DB_URL`, `HMAC_PEPPER`, `OTP_ENC_KEY`, `LINKS_SECRET`, `TURNSTILE_SECRET`, `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `EVOLUTION_WEBHOOK_SECRET`, `SMTP_*`, `NBX_*`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_DC`, `META_PIXEL_ID`, `META_CAPI_TOKEN`, `STAPE_URL`, `GA4_API_SECRET`, `ALLOWED_ORIGIN`, `PANEL_URL`. Opcionales del cierre backend: `EVOLUTION_WEBHOOK_TZ_OFFSET_MIN`, `GEOIP_URL`, `GEOIP_TIMEOUT_MS`, `TRACKING_RATE_LIMIT_GLOBAL`, `ALERTAS_WEBHOOK_URL`, `ALERTAS_EMAIL`, `ALERTAS_ENTORNO`, `ALERTAS_SECRET`, `ALERTAS_CONFIG`.

### observabilidad (`src/domains/observabilidad/index.ts`, cierre backend)
`ejecutarAlertas`, `NotificadorAlertasPort` (webhook genérico, correo vía `EmailPort` de comunicación), `crearRepoAlertasSql`. SQL: `shared.alertas`, `shared.evaluar_alertas`, `shared.alertas_pendientes`, `shared.alertas_marcar` y las lecturas `captacion.api_metricas_otp`, `comunicacion.api_otp_envios_fallidos`, `citas.api_zoho_alertas_desde`, `privacidad.api_ultima_retencion` (solo service_role).
