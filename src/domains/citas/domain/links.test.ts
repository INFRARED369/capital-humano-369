import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { firmarLinkGestion, verificarLinkGestion } from './links.ts';

const SECRETO = 'secreto-de-pruebas-0123456789abcdef';
const citaId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const reloj = () => new FixedClock(new Date('2026-11-17T12:00:00Z'));

describe('links firmados de gestión (CIT-11, C15)', () => {
  it('firma y verifica un link vigente', async () => {
    const token = await firmarLinkGestion({ citaId, accion: 'cancelar', expiraEn: '2026-11-18T12:00:00Z' }, SECRETO);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(await verificarLinkGestion(token, SECRETO, reloj())).toEqual({ ok: true, value: { citaId, accion: 'cancelar', expiraEn: '2026-11-18T12:00:00.000Z' } });
  });

  it('C15 · vencido → TOKEN_VENCIDO', async () => {
    const token = await firmarLinkGestion({ citaId, accion: 'reprogramar', expiraEn: '2026-11-17T11:59:59Z' }, SECRETO);
    expect(await verificarLinkGestion(token, SECRETO, reloj())).toEqual({ ok: false, error: 'TOKEN_VENCIDO' });
  });

  it('C15 · alterado (payload, firma o secreto) → TOKEN_INVALIDO', async () => {
    const token = await firmarLinkGestion({ citaId, accion: 'cancelar', expiraEn: '2026-11-18T12:00:00Z' }, SECRETO);
    const [p, f] = token.split('.') as [string, string];
    const otroPayload = Buffer.from(JSON.stringify({ c: citaId, a: 'reprogramar', e: 1795000000 })).toString('base64url');
    const casos = [
      `${otroPayload}.${f}`,
      `${p}.${f.slice(0, -1)}${f.endsWith('0') ? '1' : '0'}`,
      `${p}`,
      '',
      'a.b.c',
      `${Buffer.from('no-json').toString('base64url')}.${f}`,
    ];
    for (const t of casos) expect((await verificarLinkGestion(t, SECRETO, reloj())).ok, t).toBe(false);
    expect(await verificarLinkGestion(token, 'otro-secreto-0123456789abcdefghij', reloj())).toEqual({ ok: false, error: 'TOKEN_INVALIDO' });
  });

  it('payload firmado pero con forma inválida → TOKEN_INVALIDO', async () => {
    const { hmacSha256Hex } = await import('@shared/crypto.ts');
    const p = Buffer.from(JSON.stringify({ c: 'x', a: 'borrar', e: 'y' })).toString('base64url');
    const t = `${p}.${await hmacSha256Hex(SECRETO, `citas.gestion.v1.${p}`)}`;
    expect(await verificarLinkGestion(t, SECRETO, reloj())).toEqual({ ok: false, error: 'TOKEN_INVALIDO' });
  });

  it('exige un secreto de al menos 32 caracteres y datos válidos al firmar', async () => {
    await expect(firmarLinkGestion({ citaId, accion: 'cancelar', expiraEn: '2026-11-18T12:00:00Z' }, 'corto')).rejects.toThrow();
    await expect(firmarLinkGestion({ citaId: 'x', accion: 'cancelar', expiraEn: '2026-11-18T12:00:00Z' }, SECRETO)).rejects.toThrow();
    await expect(firmarLinkGestion({ citaId, accion: 'cancelar', expiraEn: 'nunca' }, SECRETO)).rejects.toThrow();
    expect(await verificarLinkGestion('x.y', 'corto', reloj())).toEqual({ ok: false, error: 'TOKEN_INVALIDO' });
  });
});
