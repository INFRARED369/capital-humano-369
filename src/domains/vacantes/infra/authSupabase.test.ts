import { describe, expect, it, vi } from 'vitest';
import { crearVerificadorSupabaseAuth, extraerBearer } from './authSupabase.ts';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJh';
const ID = '00000000-0000-4000-8000-0000000000ad';

describe('extraerBearer', () => {
  it('lee "Bearer <token>" y rechaza lo demás', () => {
    expect(extraerBearer(`Bearer ${JWT}`)).toBe(JWT);
    expect(extraerBearer(`bearer ${JWT}`)).toBe(JWT);
    for (const h of [null, '', 'Basic abc', 'Bearer ', `Bearer ${'a'.repeat(5000)}`]) expect(extraerBearer(h)).toBeNull();
  });
});

describe('crearVerificadorSupabaseAuth (GET /auth/v1/user)', () => {
  it('token válido → usuarioId; manda apikey y Authorization', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: ID, email: 'a@b.mx' }), { status: 200 }));
    const v = crearVerificadorSupabaseAuth({ url: 'https://p.supabase.co/', anonKey: 'anon', fetch: f });
    expect(await v.verificar(JWT)).toEqual({ usuarioId: ID });
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://p.supabase.co/auth/v1/user');
    expect(new Headers(init.headers).get('apikey')).toBe('anon');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${JWT}`);
  });

  it('401, id no uuid o token sin forma de JWT → null (sin red en el último caso)', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 401 }));
    const v = crearVerificadorSupabaseAuth({ url: 'https://p.supabase.co', anonKey: 'anon', fetch: f });
    expect(await v.verificar(JWT)).toBeNull();
    const v2 = crearVerificadorSupabaseAuth({ url: 'https://p.supabase.co', anonKey: 'anon', fetch: async () => new Response(JSON.stringify({ id: 'x' })) });
    expect(await v2.verificar(JWT)).toBeNull();
    f.mockClear();
    expect(await v.verificar('no-es-jwt')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
