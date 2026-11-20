import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ContactoB2BSchema, SERVICIOS_B2B, validarContactoB2B } from './b2b.ts';
import { ContenidoVacanteSchema } from './contenido.ts';

const DIR = join(import.meta.dirname, '..', '..', '..', '..', 'apps', 'web', 'vacantes');

describe('contenido por vacante (apps/web/vacantes/*.json)', () => {
  const archivos = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  it('existe al menos agente-smart', () => {
    expect(archivos).toContain('agente-smart.json');
  });
  it.each(archivos)('%s cumple el esquema y su slug coincide con el archivo', (f) => {
    const datos = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    const r = ContenidoVacanteSchema.safeParse(datos);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
    expect(datos.slug).toBe(f.replace(/\.json$/, ''));
  });
  it('rechaza contenido con campos desconocidos (typos en el JSON)', () => {
    const datos = JSON.parse(readFileSync(join(DIR, 'agente-smart.json'), 'utf8'));
    expect(ContenidoVacanteSchema.safeParse({ ...datos, titluo: 'x' }).success).toBe(false);
  });
});

describe('contacto B2B (CAP-09)', () => {
  const valido = {
    nombre: 'Laura', empresa: 'ACME', email: 'laura@acme.mx', servicio: SERVICIOS_B2B[0], mensaje: '',
    consentimiento: { aceptado: true, version: '2026-11-13' }, turnstile_token: 't',
  };
  it('acepta un contacto válido', () => {
    const r = validarContactoB2B(valido);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mensaje).toBeNull();
  });
  it('rechaza servicio desconocido, email inválido y campos extra', () => {
    expect(validarContactoB2B({ ...valido, servicio: 'Otro' }).ok).toBe(false);
    expect(validarContactoB2B({ ...valido, email: 'x' }).ok).toBe(false);
    expect(validarContactoB2B({ ...valido, hack: 1 }).ok).toBe(false);
    expect(ContactoB2BSchema.safeParse({ ...valido, mensaje: 'x'.repeat(2001) }).success).toBe(false);
  });
  it('sin consentimiento o anti-bot → códigos específicos', () => {
    const a = validarContactoB2B({ ...valido, consentimiento: { aceptado: false, version: 'v' } });
    expect(!a.ok && a.error.codigo).toBe('CONSENTIMIENTO_REQUERIDO');
    const b = validarContactoB2B({ ...valido, turnstile_token: '' });
    expect(!b.ok && b.error.codigo).toBe('ANTIBOT_REQUERIDO');
  });
});
