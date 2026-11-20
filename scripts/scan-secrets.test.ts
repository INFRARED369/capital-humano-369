/**
 * S5 / NFR-SEG-02 · El escáner de `out/` detecta secretos y no da falsos positivos
 * con lo que legítimamente viaja al navegador (anon key, publishable key, site keys).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { escanearDirectorio, escanearTexto } from './scan-secrets.mjs';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.${'s'.repeat(43)}`;
const reglas = (texto: string) => escanearTexto(texto, 'x.js').map((h) => h.regla);
const hex = (n: number) => 'a1b2c3d4e5f6'.repeat(10).slice(0, n);

// Las llaves falsas se arman por partes para que el push protection de GitHub no las tome por reales.
describe('S5 · casos positivos (deben detectarse)', () => {
  const positivos: Array<[string, string, string]> = [
    ['JWT service_role de Supabase', `const k="${jwt({ iss: 'supabase', role: 'service_role', exp: 2e9 })}"`, 'jwt-no-anon'],
    ['JWT con rol desconocido', `x=${jwt({ role: 'supabase_admin' })}`, 'jwt-no-anon'],
    ['JWT sin rol', `x=${jwt({ sub: 'u1' })}`, 'jwt-no-anon'],
    ['secret key nueva de Supabase', `k="${'sb_' + 'secret_'}N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz"`, 'supabase-secret-key'],
    ['sk_live', `stripe("${'sk_' + 'live_'}51HxYzAbCdEfGhIjKlMnOpQr")`, 'sk-key'],
    ['sk_test', `k="${'sk_' + 'test_'}4eC39HqLyjWDarjtT1zdp7dc"`, 'sk-key'],
    ['sk- tipo OpenAI', 'k="sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"', 'sk-key'],
    ['token de Meta EAA…', 'access_token=EAAGm0PX4ZCpsBAKZCZAqZBZCEZAZBbZBZAyZCZBZCZAZCbZBZAZCZBZCZA9', 'meta-token'],
    ['refresh token de Zoho', `r="1000.${hex(32)}.${hex(32)}"`, 'zoho-token'],
    ['client id de Zoho', 'c="1000.ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"', 'zoho-token'],
    ['llave privada PEM', '-----BEGIN PRIVATE KEY-----\nMIIEv...', 'llave-privada'],
    ['llave privada RSA', '-----BEGIN RSA PRIVATE KEY-----', 'llave-privada'],
    ['llave privada OpenSSH', '-----BEGIN OPENSSH PRIVATE KEY-----', 'llave-privada'],
    ['HMAC_PEPPER asignado', 'HMAC_PEPPER=s3cr3t-pepper-value', 'variable-servidor'],
    ['ZOHO_REFRESH_TOKEN en objeto', '{ZOHO_REFRESH_TOKEN:"abc"}', 'variable-servidor'],
    ['nombre de variable de servidor en bundle', 'process.env.META_CAPI_TOKEN', 'variable-servidor'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'variable-servidor'],
    ['URL de Postgres con contraseña', 'postgresql://postgres.abc:Sup3rS3cret@aws-0-us-east-1.pooler.supabase.com:6543/postgres', 'url-con-credenciales'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['token de GitHub', `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`, 'github-token'],
  ];
  it.each(positivos)('%s', (_n, texto, regla) => {
    expect(reglas(texto)).toContain(regla);
  });

  it('reporta archivo y línea, y no imprime el secreto completo', () => {
    const secreto = `1000.${hex(32)}.${hex(32)}`;
    const [h] = escanearTexto(`a\nb\nconst r="${secreto}"`, 'app.js');
    expect(h).toMatchObject({ archivo: 'app.js', linea: 3, regla: 'zoho-token' });
    expect(h!.muestra).not.toContain(secreto);
    expect(h!.muestra.length).toBeLessThan(20);
  });
});

describe('S5 · casos negativos (no deben detectarse)', () => {
  const negativos: Array<[string, string]> = [
    ['anon key de Supabase (pública por diseño)', `NEXT_PUBLIC_SUPABASE_ANON_KEY="${jwt({ iss: 'supabase', role: 'anon', exp: 2e9 })}"`],
    ['publishable key nueva', 'k="sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"'],
    ['site key de Turnstile', 'sitekey:"0x4AAAAAAABkMYinukE8nzY"'],
    ['site key de prueba de Turnstile', '1x00000000000000000000AA'],
    ['decimales en código minificado', 'var a=1000.5,b=1000.000000000000000001;'],
    ['palabras con sk_ cortas', 'const task_id=1, mask_x=2, disk_size=3;'],
    ['EAA corto', 'const EAAX=1; "EAAB"'],
    ['texto de portada', '<h1>369 Capital Humano</h1><p>Reclutamiento</p>'],
    ['URL de Postgres sin contraseña', 'postgres://localhost:5432/db'],
    ['URL de Supabase pública', 'https://abcd.supabase.co/functions/v1/postular'],
    ['variable pública NEXT_PUBLIC', 'process.env.NEXT_PUBLIC_META_PIXEL_ID'],
    ['clases CSS', '.task-list{color:red}.mask-image{}'],
  ];
  it.each(negativos)('%s', (_n, texto) => {
    expect(escanearTexto(texto, 'x.js')).toEqual([]);
  });
});

describe('escaneo de directorio y CLI', () => {
  let limpio: string;
  let sucio: string;
  beforeAll(() => {
    limpio = mkdtempSync(join(tmpdir(), 'scan-limpio-'));
    mkdirSync(join(limpio, '_next', 'static'), { recursive: true });
    writeFileSync(join(limpio, 'index.html'), '<html><body>ok</body></html>');
    writeFileSync(join(limpio, '_next', 'static', 'a.js'), `const anon="${jwt({ role: 'anon' })}"`);
    // Un binario con bytes que parecerían secreto no se escanea como texto.
    writeFileSync(join(limpio, 'video.mp4'), Buffer.from('-----BEGIN PRIVATE KEY-----'));

    sucio = mkdtempSync(join(tmpdir(), 'scan-sucio-'));
    mkdirSync(join(sucio, 'vacantes', 'x'), { recursive: true });
    writeFileSync(join(sucio, 'vacantes', 'x', 'index.html'), `<script>var t="EAAGm0PX4ZCpsBAKZCZAqZBZCEZAZBbZBZAyZCZBZCZA9"</script>`);
    writeFileSync(join(sucio, '.env.production'), 'X=1');
  });
  afterAll(() => {
    rmSync(limpio, { recursive: true, force: true });
    rmSync(sucio, { recursive: true, force: true });
  });

  it('directorio limpio → sin hallazgos', async () => {
    expect(await escanearDirectorio(limpio)).toEqual([]);
  });

  it('directorio con secreto y archivo .env → hallazgos con ruta relativa', async () => {
    const h = await escanearDirectorio(sucio);
    expect(h.map((x) => `${x.regla}@${x.archivo}`).sort()).toEqual(['archivo-env@.env.production', 'meta-token@vacantes/x/index.html']);
  });

  it('CLI: exit 0 limpio, 1 con hallazgos, 2 si falta el directorio', () => {
    const cli = (dir: string) => spawnSync(process.execPath, [join(import.meta.dirname, 'scan-secrets.mjs'), dir], { encoding: 'utf8' });
    expect(cli(limpio).status).toBe(0);
    const r = cli(sucio);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('meta-token');
    expect(r.stderr).not.toContain('EAAGm0PX4ZCpsBAKZCZAqZBZCEZAZBbZBZAyZCZBZCZA9');
    expect(cli(join(limpio, 'no-existe')).status).toBe(2);
  });
});
