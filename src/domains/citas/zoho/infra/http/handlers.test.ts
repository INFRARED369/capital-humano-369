import { describe, expect, it } from 'vitest';
import { crearLogger } from '@shared/logger.ts';
import { crearHandlerCronZoho, leerConfigZoho, verificarBearer } from './handlers.ts';

const env = {
  ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'csecret', ZOHO_REFRESH_TOKEN: '1000.rt', ZOHO_DC: 'com',
  PANEL_URL: 'https://panel.369.mx', SUPABASE_SERVICE_ROLE_KEY: 'srk-123',
};

describe('leerConfigZoho (secretos solo por entorno)', () => {
  it('arma la configuración completa', () => {
    expect(leerConfigZoho(env)).toEqual({
      ok: true,
      value: { zoho: { dc: 'com', clientId: 'cid', clientSecret: 'csecret', refreshToken: '1000.rt' }, panelUrl: 'https://panel.369.mx', zonaHoraria: 'America/Mexico_City', secretoCron: 'srk-123' },
    });
  });

  it('lista SOLO los nombres de las variables faltantes o inválidas (nunca valores)', () => {
    const r = leerConfigZoho({ ...env, ZOHO_REFRESH_TOKEN: '', ZOHO_DC: 'x.evil', PANEL_URL: 'javascript:alert(1)' });
    expect(r).toEqual({ ok: false, error: ['ZOHO_REFRESH_TOKEN', 'ZOHO_DC', 'PANEL_URL'] });
  });

  it('ZOHO_CRON_SECRET tiene prioridad sobre SUPABASE_SERVICE_ROLE_KEY; sin ninguno, falta la service key', () => {
    const r = leerConfigZoho({ ...env, ZOHO_CRON_SECRET: 'cron-legacy-jwt' });
    expect(r.ok && r.value.secretoCron).toBe('cron-legacy-jwt');
    expect(leerConfigZoho({ ...env, SUPABASE_SERVICE_ROLE_KEY: '' })).toEqual({ ok: false, error: ['SUPABASE_SERVICE_ROLE_KEY'] });
  });

  it('PANEL_URL debe ser https (salvo localhost) y ZOHO_TZ es opcional', () => {
    expect(leerConfigZoho({ ...env, PANEL_URL: 'http://panel.369.mx' }).ok).toBe(false);
    const r = leerConfigZoho({ ...env, PANEL_URL: 'http://localhost:3000', ZOHO_TZ: 'America/Monterrey' });
    expect(r.ok && r.value.zonaHoraria).toBe('America/Monterrey');
  });
});

describe('verificarBearer', () => {
  const req = (h?: string) => new Request('https://x/fn', { method: 'POST', headers: h ? { authorization: h } : {} });
  it('acepta solo el bearer exacto', () => {
    expect(verificarBearer(req('Bearer srk-123'), 'srk-123')).toBe(true);
    expect(verificarBearer(req('Bearer srk-124'), 'srk-123')).toBe(false);
    expect(verificarBearer(req(), 'srk-123')).toBe(false);
    expect(verificarBearer(req('Bearer '), '')).toBe(false);
  });
});

describe('crearHandlerCronZoho (zoho-sync-worker / zoho-reconciliacion)', () => {
  const logs: string[] = [];
  const logger = crearLogger({}, (l) => logs.push(l));
  const handler = (ejecutar: () => Promise<unknown>) => crearHandlerCronZoho({ nombre: 'zoho-sync-worker', secreto: 'srk-123', logger, ejecutar });
  const post = (auth = 'Bearer srk-123') => new Request('https://x/zoho-sync-worker', { method: 'POST', headers: { authorization: auth } });

  it('solo POST', async () => {
    const r = await handler(async () => ({}))(new Request('https://x', { method: 'GET' }));
    expect(r.status).toBe(405);
  });

  it('401 sin autorización y no ejecuta', async () => {
    let corrio = false;
    const r = await handler(async () => { corrio = true; })(post('Bearer otro'));
    expect(r.status).toBe(401);
    expect(corrio).toBe(false);
  });

  it('200 con el resumen', async () => {
    const r = await handler(async () => ({ completados: 2 }))(post());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resumen: { completados: 2 } });
  });

  it('500 genérico ante una excepción, sin filtrar el mensaje', async () => {
    const r = await handler(async () => { throw new Error('password=supersecreto 5512345678'); })(post());
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).not.toContain('supersecreto');
    expect(logs.join('\n')).not.toContain('5512345678');
  });
});
