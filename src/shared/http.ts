/** Utilidades HTTP comunes a las edge functions (handlers puros Request → Response). */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

export function cors(origenPermitido: string): Record<string, string> {
  return {
    'access-control-allow-origin': origenPermitido,
    'access-control-allow-headers': 'content-type, authorization, x-correlation-id, cf-turnstile-response',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
}

export function correlationId(req: Request): string {
  const h = req.headers.get('x-correlation-id');
  return h && /^[\w-]{8,64}$/.test(h) ? h : globalThis.crypto.randomUUID();
}

export function ipCliente(req: Request): string | null {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}
