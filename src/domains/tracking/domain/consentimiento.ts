/**
 * Reglas de consentimiento (TRK-01 + Política de retención):
 * sin consentimiento solo hay conteo técnico; no se guarda IP, cookie ni visitor_id.
 */
export interface Identificadores {
  consentimiento: boolean;
  visitorId: string | null;
  ip: string | null;
  userAgent: string | null;
  fbc: string | null;
  fbp: string | null;
  gclid: string | null;
  fbclid: string | null;
}

export function sanearSegunConsentimiento<T extends Identificadores>(e: T): T {
  if (e.consentimiento) return e;
  return { ...e, visitorId: null, ip: null, userAgent: null, fbc: null, fbp: null, gclid: null, fbclid: null };
}
