import { describe, expect, it } from 'vitest';
import { crearPoliticaReintento, POLITICA_DEFECTO } from './reintento.ts';
import { prioridadDe, SolicitudMensajeSchema, TIPOS_MENSAJE } from './tipos.ts';
import { PLANTILLAS_DEFECTO, ReglasMensajesSchema, plantillaPara, renderPlantilla, VARIABLES_PERMITIDAS } from './plantillas.ts';
import { dentroDeVentana, ajustarAVentana, formatearFechaHora, partesLocales } from './ventana.ts';
import { programarRecordatorios } from './recordatorios.ts';
import { firmarWebhook, idEventoEvolution, verificarFrescura, verificarTokenWebhook, verificarWebhook } from './webhook.ts';
import { cifrarCodigoOtp, descifrarCodigoOtp } from './otp.ts';

const CLAVE = Buffer.alloc(32, 7).toString('base64');
const reglasDefecto = () => ReglasMensajesSchema.parse({});

describe('M1/M2 · PoliticaReintento(max=2) con backoff', () => {
  it('1 intento + 2 reintentos = 3 intentos máximos', () => {
    expect(POLITICA_DEFECTO.maxIntentos).toBe(3);
    expect(crearPoliticaReintento({ maxReintentos: 2 }).maxIntentos).toBe(3);
  });

  it('falla en el intento 1 y 2 → reintenta con backoff exponencial; en el 3 → dead letter', () => {
    const p = crearPoliticaReintento({ maxReintentos: 2, baseSeg: 30, factor: 4 });
    expect(p.decidir(1)).toEqual({ accion: 'reintentar', backoffSeg: 30 });
    expect(p.decidir(2)).toEqual({ accion: 'reintentar', backoffSeg: 120 });
    expect(p.decidir(3)).toEqual({ accion: 'dead_letter' });
    expect(p.decidir(9)).toEqual({ accion: 'dead_letter' });
  });

  it('un error permanente va directo a dead letter', () => {
    expect(POLITICA_DEFECTO.decidir(1, { permanente: true })).toEqual({ accion: 'dead_letter' });
  });

  it('el backoff tiene tope', () => {
    const p = crearPoliticaReintento({ maxReintentos: 5, baseSeg: 60, factor: 10, topeSeg: 900 });
    expect(p.decidir(4)).toEqual({ accion: 'reintentar', backoffSeg: 900 });
  });

  it('rechaza configuraciones inválidas', () => {
    expect(() => crearPoliticaReintento({ maxReintentos: -1 })).toThrow();
    expect(() => crearPoliticaReintento({ baseSeg: 0 })).toThrow();
  });
});

describe('M9 · prioridad por tipo', () => {
  it('OTP tiene prioridad 0 (la más alta) y es menor que cualquier otro tipo', () => {
    expect(prioridadDe('otp')).toBe(0);
    for (const t of TIPOS_MENSAJE.filter((t) => t !== 'otp')) expect(prioridadDe(t)).toBeGreaterThan(0);
    expect(prioridadDe('recordatorio_24h')).toBeGreaterThan(prioridadDe('confirmacion'));
    for (const t of TIPOS_MENSAJE) expect(prioridadDe(t)).toBeLessThanOrEqual(9);
  });
});

describe('SolicitudMensajeSchema (contrato)', () => {
  const base = { tipo: 'confirmacion', canal: 'whatsapp', leadId: '0190d3a0-0000-7000-8000-000000000001', vacanteId: '0190d3a0-0000-7000-8000-000000000002', clienteId: '0190d3a0-0000-7000-8000-000000000003', llave: 'confirmacion:c1' };
  it('acepta una solicitud válida', () => {
    expect(SolicitudMensajeSchema.safeParse(base).success).toBe(true);
  });
  it('rechaza variables con PII (nombre/telefono/codigo se resuelven al enviar)', () => {
    expect(SolicitudMensajeSchema.safeParse({ ...base, variables: { telefono: '5512345678' } }).success).toBe(false);
    expect(SolicitudMensajeSchema.safeParse({ ...base, variables: { codigo: '123456' } }).success).toBe(false);
    expect(SolicitudMensajeSchema.safeParse({ ...base, variables: { fecha: 'lunes', hora: '10:00' } }).success).toBe(true);
  });
  it('el OTP exige el código cifrado y no admite código en claro', () => {
    expect(SolicitudMensajeSchema.safeParse({ ...base, tipo: 'otp', llave: 'otp:1' }).success).toBe(false);
    expect(SolicitudMensajeSchema.safeParse({ ...base, tipo: 'otp', llave: 'otp:1', codigoCifrado: 'v1.aaa.bbb' }).success).toBe(true);
  });
  it('rechaza llaves vacías o enormes y canales desconocidos', () => {
    expect(SolicitudMensajeSchema.safeParse({ ...base, llave: '' }).success).toBe(false);
    expect(SolicitudMensajeSchema.safeParse({ ...base, llave: 'x'.repeat(300) }).success).toBe(false);
    expect(SolicitudMensajeSchema.safeParse({ ...base, canal: 'fax' }).success).toBe(false);
  });
});

describe('M8 · plantillas por vacante', () => {
  it('render reemplaza las variables permitidas', () => {
    const r = renderPlantilla('Hola {{nombre}}, folio {{folio}} el {{fecha}} a las {{hora}}', { nombre: 'Ana', folio: 'AS-001', fecha: 'lunes 16 nov', hora: '10:00' });
    expect(r).toEqual({ ok: true, value: 'Hola Ana, folio AS-001 el lunes 16 nov a las 10:00' });
  });
  it('variable faltante → error (no se envía texto con huecos)', () => {
    expect(renderPlantilla('Tu código {{codigo}}', {})).toEqual({ ok: false, error: 'VARIABLE_FALTANTE:codigo' });
  });
  it('variable desconocida en la plantilla → error', () => {
    expect(renderPlantilla('{{password}}', { password: 'x' } as never)).toEqual({ ok: false, error: 'VARIABLE_DESCONOCIDA:password' });
  });
  it('los valores no pueden inyectar nuevas variables', () => {
    expect(renderPlantilla('{{nombre}} {{folio}}', { nombre: '{{folio}}', folio: 'F1' })).toEqual({ ok: true, value: '{{folio}} F1' });
  });
  it('el esquema rechaza plantillas con variables fuera de la lista', () => {
    expect(ReglasMensajesSchema.safeParse({ plantillas: { confirmacion: { texto: 'hola {{telefono}}' } } }).success).toBe(false);
    expect(VARIABLES_PERMITIDAS).toContain('link_cancelar');
  });
  it('plantilla de la vacante B se usa en vez de la general; si no la define, la por defecto', () => {
    const b = ReglasMensajesSchema.parse({ plantillas: { confirmacion: { texto: 'Plantilla B {{folio}}' } } });
    expect(plantillaPara(b, 'confirmacion').texto).toBe('Plantilla B {{folio}}');
    expect(plantillaPara(b, 'otp').texto).toBe(PLANTILLAS_DEFECTO.otp.texto);
  });
  it('todas las plantillas por defecto renderizan con todas las variables', () => {
    const vars = Object.fromEntries(VARIABLES_PERMITIDAS.map((v) => [v, 'x']));
    for (const t of TIPOS_MENSAJE) expect(renderPlantilla(PLANTILLAS_DEFECTO[t].texto, vars).ok, t).toBe(true);
    expect(PLANTILLAS_DEFECTO.otp.texto).toContain('{{codigo}}');
  });
  it('valores por defecto: correo, recordatorios 24 h y 2 h, ventana 08:00–21:00 CDMX', () => {
    const r = reglasDefecto();
    expect(r.canal_preferido).toBe('email');
    expect(r.recordatorios).toEqual({ h24: { activo: true, horas_antes: 24 }, h2: { activo: true, horas_antes: 2 } });
    expect(r.ventana_contacto).toMatchObject({ zona_horaria: 'America/Mexico_City', inicio: '08:00', fin: '21:00' });
  });
  it('rechaza ventana invertida y zona horaria inválida', () => {
    expect(ReglasMensajesSchema.safeParse({ ventana_contacto: { inicio: '21:00', fin: '08:00' } }).success).toBe(false);
    expect(ReglasMensajesSchema.safeParse({ ventana_contacto: { zona_horaria: 'Marte/Olimpo' } }).success).toBe(false);
    expect(ReglasMensajesSchema.safeParse({ ventana_contacto: { dias: [] } }).success).toBe(false);
  });
});

describe('M6 · ventana horaria de contacto (America/Mexico_City, UTC-6)', () => {
  const v = reglasDefecto().ventana_contacto;
  it('dentro del horario no cambia', () => {
    const d = new Date('2026-11-16T16:00:00Z'); // 10:00 local
    expect(dentroDeVentana(d, v)).toBe(true);
    expect(ajustarAVentana(d, v, 'recordatorio_24h')).toEqual(d);
  });
  it('recordatorio a las 06:30 local se pospone a las 08:00 local del mismo día', () => {
    const d = new Date('2026-11-16T12:30:00Z');
    expect(dentroDeVentana(d, v)).toBe(false);
    expect(ajustarAVentana(d, v, 'recordatorio_2h').toISOString()).toBe('2026-11-16T14:00:00.000Z');
  });
  it('a las 22:00 local se pospone al día siguiente a las 08:00', () => {
    expect(ajustarAVentana(new Date('2026-11-17T04:00:00Z'), v, 'confirmacion').toISOString()).toBe('2026-11-17T14:00:00.000Z');
  });
  it('el OTP nunca se pospone', () => {
    const d = new Date('2026-11-17T04:00:00Z');
    expect(ajustarAVentana(d, v, 'otp')).toEqual(d);
  });
  it('respeta los días permitidos (sin domingo)', () => {
    const sinDomingo = ReglasMensajesSchema.parse({ ventana_contacto: { dias: [1, 2, 3, 4, 5, 6] } }).ventana_contacto;
    // sábado 21 nov 22:00 local → lunes 23 nov 08:00 local
    expect(ajustarAVentana(new Date('2026-11-22T04:00:00Z'), sinDomingo, 'agradecimiento').toISOString()).toBe('2026-11-23T14:00:00.000Z');
  });
  it('funciona con zonas con horario de verano', () => {
    const ny = ReglasMensajesSchema.parse({ ventana_contacto: { zona_horaria: 'America/New_York' } }).ventana_contacto;
    // 2026-07-01 05:00 EDT (UTC-4) → 08:00 EDT = 12:00Z
    expect(ajustarAVentana(new Date('2026-07-01T09:00:00Z'), ny, 'confirmacion').toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });
  it('partesLocales y formato legible en español', () => {
    expect(partesLocales(new Date('2026-11-16T16:05:00Z'), 'America/Mexico_City')).toMatchObject({ hora: 10, minuto: 5, diaSemana: 1 });
    const f = formatearFechaHora(new Date('2026-11-16T16:00:00Z'), 'America/Mexico_City');
    expect(f.hora).toBe('10:00');
    expect(f.fecha.toLowerCase()).toContain('16');
    expect(f.fecha.toLowerCase()).toContain('lunes');
  });
});

describe('COM-06 · programación de recordatorios', () => {
  const r = reglasDefecto();
  it('cita en 3 días → recordatorios 24 h y 2 h antes', () => {
    const inicio = new Date('2026-11-19T17:00:00Z'); // 11:00 local
    const out = programarRecordatorios(inicio, new Date('2026-11-16T17:00:00Z'), r);
    expect(out).toEqual([
      { tipo: 'recordatorio_24h', programadoPara: '2026-11-18T17:00:00.000Z' },
      { tipo: 'recordatorio_2h', programadoPara: '2026-11-19T15:00:00.000Z' },
    ]);
  });
  it('cita en 5 h → solo el de 2 h (el de 24 h ya pasó)', () => {
    const out = programarRecordatorios(new Date('2026-11-16T22:00:00Z'), new Date('2026-11-16T17:00:00Z'), r);
    expect(out.map((x) => x.tipo)).toEqual(['recordatorio_2h']);
  });
  it('cita en 1 h → ninguno', () => {
    expect(programarRecordatorios(new Date('2026-11-16T18:00:00Z'), new Date('2026-11-16T17:00:00Z'), r)).toEqual([]);
  });
  it('recordatorio fuera de horario se pospone; si cae después de la cita se omite', () => {
    // Cita 09:30 local (15:30Z): 2 h antes = 07:30 local → 08:00 local (14:00Z), sigue antes de la cita
    const out = programarRecordatorios(new Date('2026-11-19T15:30:00Z'), new Date('2026-11-16T17:00:00Z'), r);
    expect(out).toContainEqual({ tipo: 'recordatorio_2h', programadoPara: '2026-11-19T14:00:00.000Z' });
    // Cita 08:10 local: 2 h antes = 06:10 → 08:00, a 10 min de la cita → se omite
    const tarde = programarRecordatorios(new Date('2026-11-19T14:10:00Z'), new Date('2026-11-16T17:00:00Z'), r);
    expect(tarde.map((x) => x.tipo)).toEqual(['recordatorio_24h']);
  });
  it('configurables: horas distintas y desactivables', () => {
    const c = ReglasMensajesSchema.parse({ recordatorios: { h24: { activo: false, horas_antes: 24 }, h2: { activo: true, horas_antes: 3 } } });
    const out = programarRecordatorios(new Date('2026-11-19T20:00:00Z'), new Date('2026-11-16T17:00:00Z'), c);
    expect(out).toEqual([{ tipo: 'recordatorio_2h', programadoPara: '2026-11-19T17:00:00.000Z' }]);
  });
});

describe('M5 · firma de webhooks (HMAC + timestamp anti-replay)', () => {
  const secreto = 's3cr3t';
  const ahora = new Date('2026-11-16T17:00:00Z');
  const ts = String(Math.floor(ahora.getTime() / 1000));
  it('firma válida dentro de la tolerancia → ok', async () => {
    const firma = await firmarWebhook(secreto, ts, '{"a":1}');
    expect(firma).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verificarWebhook({ secreto, firma, timestamp: ts, cuerpo: '{"a":1}', ahora })).toEqual({ ok: true, value: undefined });
  });
  it('firma inválida, cuerpo alterado o ausente → error', async () => {
    const firma = await firmarWebhook(secreto, ts, '{"a":1}');
    expect(await verificarWebhook({ secreto, firma, timestamp: ts, cuerpo: '{"a":2}', ahora })).toEqual({ ok: false, error: 'FIRMA_INVALIDA' });
    expect(await verificarWebhook({ secreto, firma: null, timestamp: ts, cuerpo: '{}', ahora })).toEqual({ ok: false, error: 'FIRMA_AUSENTE' });
    expect(await verificarWebhook({ secreto, firma: 'sha256=00', timestamp: null, cuerpo: '{}', ahora })).toEqual({ ok: false, error: 'FIRMA_AUSENTE' });
    expect(await verificarWebhook({ secreto: '', firma, timestamp: ts, cuerpo: '{"a":1}', ahora })).toEqual({ ok: false, error: 'FIRMA_INVALIDA' });
  });
  it('timestamp viejo (>5 min) o del futuro → EXPIRADO', async () => {
    const viejo = String(Number(ts) - 301);
    const futuro = String(Number(ts) + 301);
    expect(await verificarWebhook({ secreto, firma: await firmarWebhook(secreto, viejo, 'x'), timestamp: viejo, cuerpo: 'x', ahora })).toEqual({ ok: false, error: 'EXPIRADO' });
    expect(await verificarWebhook({ secreto, firma: await firmarWebhook(secreto, futuro, 'x'), timestamp: futuro, cuerpo: 'x', ahora })).toEqual({ ok: false, error: 'EXPIRADO' });
    expect(await verificarWebhook({ secreto, firma: 'sha256=x', timestamp: 'abc', cuerpo: 'x', ahora })).toEqual({ ok: false, error: 'EXPIRADO' });
  });
});

describe('NFR-SEG-05 · Evolution v2: token de cabecera + frescura + id de evento', () => {
  const ahora = new Date('2026-11-16T17:00:00Z');
  it('token correcto → ok; ausente, vacío o distinto → error (comparación en tiempo constante)', () => {
    expect(verificarTokenWebhook('t'.repeat(32), 't'.repeat(32))).toEqual({ ok: true, value: undefined });
    expect(verificarTokenWebhook('t'.repeat(32), null)).toEqual({ ok: false, error: 'TOKEN_AUSENTE' });
    expect(verificarTokenWebhook('t'.repeat(32), '')).toEqual({ ok: false, error: 'TOKEN_AUSENTE' });
    expect(verificarTokenWebhook('t'.repeat(32), 't'.repeat(31) + 'x')).toEqual({ ok: false, error: 'TOKEN_INVALIDO' });
    expect(verificarTokenWebhook('', 'algo')).toEqual({ ok: false, error: 'TOKEN_INVALIDO' });
  });
  it('frescura: date_time dentro de ±5 min → ok; viejo, futuro, ausente o basura → EXPIRADO', () => {
    expect(verificarFrescura('2026-11-16T16:56:00.000Z', ahora)).toEqual({ ok: true, value: undefined });
    expect(verificarFrescura('2026-11-16T16:54:59.000Z', ahora)).toEqual({ ok: false, error: 'EXPIRADO' });
    expect(verificarFrescura('2026-11-16T17:05:01.000Z', ahora)).toEqual({ ok: false, error: 'EXPIRADO' });
    expect(verificarFrescura(undefined, ahora)).toEqual({ ok: false, error: 'EXPIRADO' });
    expect(verificarFrescura('ayer', ahora)).toEqual({ ok: false, error: 'EXPIRADO' });
    expect(verificarFrescura(1763312400, ahora)).toEqual({ ok: false, error: 'EXPIRADO' });
  });
  it('frescura: Evolution escribe la hora LOCAL con sufijo Z → se corrige con el desfase configurado (CDMX = -360)', () => {
    expect(verificarFrescura('2026-11-16T11:00:00.000Z', ahora)).toEqual({ ok: false, error: 'EXPIRADO' });
    expect(verificarFrescura('2026-11-16T11:00:00.000Z', ahora, { desfaseMin: -360 })).toEqual({ ok: true, value: undefined });
    expect(verificarFrescura('2026-11-16T16:59:00.000Z', ahora, { toleranciaSeg: 30 })).toEqual({ ok: false, error: 'EXPIRADO' });
  });
  it('id de evento: messages.update = keyId + estado; messages.upsert = key.id; sin id → null', () => {
    expect(idEventoEvolution({ event: 'messages.update', data: { keyId: 'BAE5', status: 'READ' } })).toBe('messages.update:BAE5:READ');
    expect(idEventoEvolution({ event: 'MESSAGES_UPDATE', data: { key: { id: 'BAE5' }, status: 'DELIVERY_ACK' } })).toBe('messages.update:BAE5:DELIVERY_ACK');
    expect(idEventoEvolution({ event: 'messages.upsert', data: { key: { id: '3EB0', remoteJid: 'x', fromMe: false } } })).toBe('messages.upsert:3EB0:');
    expect(idEventoEvolution({ event: 'connection.update', data: { state: 'open' } })).toBeNull();
    expect(idEventoEvolution('basura')).toBeNull();
    expect(idEventoEvolution({ event: 'messages.update', data: { keyId: 'x'.repeat(300), status: 'READ' } })!.length).toBeLessThanOrEqual(128);
  });
});

describe('OTP cifrado (AES-GCM)', () => {
  it('cifra y descifra; cada cifrado es distinto (IV aleatorio)', async () => {
    const a = await cifrarCodigoOtp('123456', CLAVE);
    const b = await cifrarCodigoOtp('123456', CLAVE);
    expect(a).not.toBe(b);
    expect(a).not.toContain('123456');
    expect(a).toMatch(/^v1\./);
    expect(await descifrarCodigoOtp(a, CLAVE)).toBe('123456');
  });
  it('clave incorrecta o texto alterado → falla', async () => {
    const a = await cifrarCodigoOtp('654321', CLAVE);
    await expect(descifrarCodigoOtp(a, Buffer.alloc(32, 1).toString('base64'))).rejects.toThrow();
    await expect(descifrarCodigoOtp(a.slice(0, -2) + 'AA', CLAVE)).rejects.toThrow();
    await expect(descifrarCodigoOtp('v2.x.y', CLAVE)).rejects.toThrow(/formato/);
  });
  it('valida clave de 32 bytes y código de 4 a 8 dígitos', async () => {
    await expect(cifrarCodigoOtp('123456', Buffer.alloc(16).toString('base64'))).rejects.toThrow(/clave/);
    await expect(cifrarCodigoOtp('12ab56', CLAVE)).rejects.toThrow(/código/);
  });
});
