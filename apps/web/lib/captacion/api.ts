/**
 * Cliente HTTP de las edge functions de captación y citas. Clasifica la respuesta para la UI:
 * ok · error de negocio (4xx con código) · fallback (red caída o 5xx → WhatsApp, CAP-10).
 */
export type RespuestaApi<T = Record<string, unknown>> =
  | { tipo: 'ok'; datos: T }
  | { tipo: 'error'; status: number; codigo: string; cuerpo: Record<string, unknown> }
  | { tipo: 'fallback' };

export function crearClienteCaptacion(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  const base = baseUrl.replace(/\/+$/, '');
  async function llamar<T>(ruta: string, init?: RequestInit): Promise<RespuestaApi<T>> {
    try {
      const r = await fetchImpl(`${base}${ruta}`, { ...init, signal: AbortSignal.timeout(15_000) });
      const cuerpo = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok) return { tipo: 'ok', datos: cuerpo as T };
      if (r.status >= 500) return { tipo: 'fallback' };
      return { tipo: 'error', status: r.status, codigo: typeof cuerpo.error === 'string' ? cuerpo.error : 'DESCONOCIDO', cuerpo };
    } catch {
      return { tipo: 'fallback' };
    }
  }
  const post = <T>(ruta: string, body: unknown) => llamar<T>(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    obtenerSlots: (slug: string) => llamar<unknown>(`/citas-api?vacante=${encodeURIComponent(slug)}`),
    postular: (body: unknown) => post<Record<string, unknown>>('/postular', body),
    verificarOtp: (leadId: string, codigo: string) => post<Record<string, unknown>>('/verificar-otp', { lead_id: leadId, codigo }),
    reenviarOtp: (leadId: string, canal: string, email?: string) =>
      post<Record<string, unknown>>('/verificar-otp/reenviar', { lead_id: leadId, canal, ...(email ? { email } : {}) }),
    enviarContactoB2B: (body: unknown) => post<Record<string, unknown>>('/contacto-b2b', body),
  };
}
