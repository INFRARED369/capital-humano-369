import { describe, expect, it } from 'vitest';
import { UUID_V7_RE } from '../../../../src/shared/ids';
import { PREGUNTAS_PRUEBA } from '../../../../src/domains/captacion/infra/testing/fakes';
import { crearClienteCaptacion } from './api';
import { calcularIngreso, formatoMxn } from './calculadora';
import { construirPostulacion, erroresPorCampo } from './formulario';
import { destinoOtp, estadoInicial, formatearTelefono, mensajeError, reducir } from './flujo';
import { agruparPorDia, etiquetaHora, interpretarAgenda, parsearSlots } from './slots';
import { segmentar } from './texto';
import { HITOS_VACIOS, hitosVideo } from './video';
import { linkAgendaWhatsApp, linkWhatsApp, mensajeAgendaWhatsApp, mensajeFallback, referenciaDe } from './whatsapp';

describe('texto con marcado mínimo (sin HTML)', () => {
  it('separa **negrita** y __énfasis__', () => {
    expect(segmentar('Hola **mundo** y __todo__.')).toEqual([
      { texto: 'Hola ', estilo: 'normal' }, { texto: 'mundo', estilo: 'strong' }, { texto: ' y ', estilo: 'normal' }, { texto: 'todo', estilo: 'b' }, { texto: '.', estilo: 'normal' },
    ]);
  });
  it('no interpreta HTML: lo deja como texto', () => {
    expect(segmentar('<img src=x onerror=alert(1)>')).toEqual([{ texto: '<img src=x onerror=alert(1)>', estilo: 'normal' }]);
  });
  it('marcado sin cerrar queda literal', () => {
    expect(segmentar('a **b')).toEqual([{ texto: 'a **b', estilo: 'normal' }]);
  });
});

describe('calculadora de ingresos', () => {
  it('base + comisión × semanas', () => {
    expect(calcularIngreso({ base_mensual: 6000, semanas_por_mes: 4 }, 1500)).toEqual({ comisionMensual: 6000, total: 12000 });
    expect(formatoMxn(12000)).toBe('$12,000');
  });
});

describe('hitos del video (VideoPlay, VideoProgress50, VideoComplete una sola vez)', () => {
  it('emite cada hito una vez', () => {
    let e = HITOS_VACIOS;
    const r1 = hitosVideo(e, { reproduciendo: true, actual: 1, duracion: 100, terminado: false });
    expect(r1.eventos).toEqual(['VideoPlay']);
    e = r1.estado;
    const r2 = hitosVideo(e, { reproduciendo: true, actual: 60, duracion: 100, terminado: false });
    expect(r2.eventos).toEqual(['VideoProgress50']);
    e = r2.estado;
    expect(hitosVideo(e, { reproduciendo: true, actual: 70, duracion: 100, terminado: false }).eventos).toEqual([]);
    const r3 = hitosVideo(e, { reproduciendo: false, actual: 100, duracion: 100, terminado: true });
    expect(r3.eventos).toEqual(['VideoComplete']);
    expect(hitosVideo(r3.estado, { reproduciendo: false, actual: 100, duracion: 100, terminado: true }).eventos).toEqual([]);
  });
  it('sin duración no calcula el 50 %', () => {
    expect(hitosVideo(HITOS_VACIOS, { reproduciendo: true, actual: 5, duracion: 0, terminado: false }).eventos).toEqual(['VideoPlay']);
  });
});

describe('slots de citas-api', () => {
  const crudo = {
    zona_horaria: 'America/Monterrey',
    slots: [
      { inicio_utc: '2026-11-17T15:30:00Z', fecha: '2026-11-17', hora_local: '09:30', disponibles: 1 },
      { inicio_utc: '2026-11-17T21:00:00Z', fecha: '2026-11-17', hora_local: '15:00', disponibles: 0 },
      { inicio_utc: '2026-11-18T16:00:00Z', fecha: '2026-11-18', hora_local: '10:00', disponibles: 1 },
    ],
  };
  it('parsea y descarta los llenos', () => {
    const r = parsearSlots(crudo);
    expect(r?.zona).toBe('America/Monterrey');
    expect(r?.slots.map((s) => s.inicio)).toEqual(['2026-11-17T15:30:00Z', '2026-11-18T16:00:00Z']);
  });
  it('respuesta inválida → null', () => {
    expect(parsearSlots({ slots: 'x' })).toBeNull();
    expect(parsearSlots(null)).toBeNull();
  });
  it('agrupa por día con etiquetas en español', () => {
    const g = agruparPorDia(parsearSlots(crudo)!.slots);
    expect(g.map((d) => [d.fecha, d.etiqueta, d.horas.map((h) => h.etiqueta)])).toEqual([
      ['2026-11-17', 'Mar 17 Nov', ['9:30 am']],
      ['2026-11-18', 'Mié 18 Nov', ['10:00 am']],
    ]);
    expect(etiquetaHora('15:00')).toBe('3:00 pm');
    expect(etiquetaHora('12:30')).toBe('12:30 pm');
    expect(etiquetaHora('00:15')).toBe('12:15 am');
  });
});

describe('F7.4 · modo de agenda de citas-api', () => {
  it("agenda_modo 'whatsapp' → flujo de WhatsApp (sin pantalla de horarios)", () => {
    expect(interpretarAgenda({ tipo: 'ok', datos: { agenda_modo: 'whatsapp', zona_horaria: 'America/Monterrey', slots: [] } })).toEqual({ tipo: 'whatsapp' });
  });
  it("agenda_modo 'sistema' (o ausente, contrato anterior) → días agrupados", () => {
    const crudo = { zona_horaria: 'America/Monterrey', slots: [{ inicio_utc: '2026-11-17T15:30:00Z', fecha: '2026-11-17', hora_local: '09:30', disponibles: 1 }] };
    for (const datos of [{ ...crudo, agenda_modo: 'sistema' }, crudo]) {
      const r = interpretarAgenda({ tipo: 'ok', datos });
      expect(r.tipo).toBe('horarios');
      if (r.tipo === 'horarios') expect(r.dias.map((d) => d.fecha)).toEqual(['2026-11-17']);
    }
  });
  it('5xx, red caída, 4xx o respuesta ilegible → fallback; modo desconocido → fallback', () => {
    expect(interpretarAgenda({ tipo: 'fallback' })).toEqual({ tipo: 'fallback' });
    expect(interpretarAgenda({ tipo: 'error', status: 404, codigo: 'VACANTE_NO_ENCONTRADA', cuerpo: {} })).toEqual({ tipo: 'fallback' });
    expect(interpretarAgenda({ tipo: 'ok', datos: { slots: 'x' } })).toEqual({ tipo: 'fallback' });
    expect(interpretarAgenda({ tipo: 'ok', datos: { agenda_modo: 'telefono', slots: [] } })).toEqual({ tipo: 'fallback' });
  });
});

describe('cuerpo de la postulación', () => {
  const valores = { nombre: 'Ana López', telefono: '81 1234 5678', email: '', respuestas: { edad: '20', manejo_pc: 'no', papeleria: 'no' } };
  it('construye el POST con event_id UUID v7, consentimiento y atribución sin nulos', async () => {
    const r = await construirPostulacion({
      slug: 'agente-smart', preguntas: PREGUNTAS_PRUEBA, valores, slotInicio: '2026-11-17T15:30:00Z', versionAviso: '2026-11-13', consentido: true,
      turnstileToken: 'tok', atribucion: { visitor_id: null, utm_source: 'facebook' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.event_id).toMatch(UUID_V7_RE);
    expect(r.value).toMatchObject({ vacante: 'agente-smart', telefono: '81 1234 5678', consentimiento: { aceptado: true, version: '2026-11-13' }, atribucion: { utm_source: 'facebook' } });
    expect(r.value.atribucion).not.toHaveProperty('visitor_id');
    expect(r.value).not.toHaveProperty('email');
  });
  it('valida en el cliente con el mismo esquema del servidor', async () => {
    const r = await construirPostulacion({ slug: 'agente-smart', preguntas: PREGUNTAS_PRUEBA, valores: { ...valores, telefono: '123' }, slotInicio: '2026-11-17T15:30:00Z', versionAviso: 'v', consentido: false, turnstileToken: '', atribucion: { visitor_id: null } });
    expect(r.ok).toBe(false);
    if ('error' in r) expect(Object.keys(r.error)).toEqual(expect.arrayContaining(['telefono', 'consentimiento']));
  });
  it('envía el canal del código; por correo exige email', async () => {
    const base = { slug: 'agente-smart', preguntas: PREGUNTAS_PRUEBA, slotInicio: '2026-11-17T15:30:00Z', versionAviso: 'v', consentido: true, turnstileToken: 'tok', atribucion: {} };
    const sms = await construirPostulacion({ ...base, valores, canalOtp: 'sms' });
    expect(sms.ok && sms.value.canal_otp).toBe('sms');
    const sinCorreo = await construirPostulacion({ ...base, valores, canalOtp: 'email' });
    expect('error' in sinCorreo && Object.keys(sinCorreo.error)).toEqual(['email']);
    expect((await construirPostulacion({ ...base, valores: { ...valores, email: 'ana@correo.mx' }, canalOtp: 'email' })).ok).toBe(true);
  });
  it('erroresPorCampo traduce la respuesta 422 del servidor', () => {
    expect(erroresPorCampo([{ campo: 'respuestas.edad', mensaje: 'x' }, { campo: 'telefono', mensaje: 'y' }])).toEqual({ 'respuestas.edad': 'x', telefono: 'y' });
  });
});

describe('máquina de estados del flujo', () => {
  it('formulario → horario → otp → pase', () => {
    let s = estadoInicial;
    s = reducir(s, { tipo: 'datos_listos' });
    expect(s.paso).toBe('horario');
    s = reducir(s, { tipo: 'postulado', leadId: 'l1', folio: '369-ABCDEF', expiraEn: 'x', reenviosRestantes: 2, canal: 'whatsapp' });
    expect(s).toMatchObject({ paso: 'otp', leadId: 'l1', folio: '369-ABCDEF', canal: 'whatsapp' });
    s = reducir(s, { tipo: 'reenviado', expiraEn: 'y', reenviosRestantes: 1, canal: 'sms' });
    expect(s).toMatchObject({ paso: 'otp', canal: 'sms', reenviosRestantes: 1 });
    s = reducir(s, { tipo: 'verificado', inicio: '2026-11-17T15:30:00Z', fin: 'f' });
    expect(s).toMatchObject({ paso: 'pase', citaInicio: '2026-11-17T15:30:00Z' });
  });
  it('horario lleno o retención expirada vuelven a elegir horario con mensaje', () => {
    const s = reducir({ ...estadoInicial, paso: 'otp' }, { tipo: 'elegir_otro_horario', mensaje: 'm' });
    expect(s).toMatchObject({ paso: 'horario', aviso: 'm' });
  });
  it("F7.4 · agenda_whatsapp lleva al paso 'whatsapp' y 'volver' regresa al formulario", () => {
    const s = reducir(estadoInicial, { tipo: 'agenda_whatsapp' });
    expect(s).toMatchObject({ paso: 'whatsapp', aviso: null });
    expect(reducir(s, { tipo: 'volver' }).paso).toBe('formulario');
  });
  it('fallback conserva lo capturado (CAP-10)', () => {
    const s = reducir({ ...estadoInicial, paso: 'otp', folio: '369-ABCDEF' }, { tipo: 'fallback' });
    expect(s).toMatchObject({ paso: 'fallback', folio: '369-ABCDEF' });
    expect(reducir(s, { tipo: 'volver' }).paso).toBe('formulario');
  });
  it('el destino del código siempre es legible: teléfono con lada o correo', () => {
    expect(formatearTelefono('81 1234 5678')).toBe('+52 81 1234 5678');
    expect(destinoOtp('whatsapp', '8112345678', '')).toBe('+52 81 1234 5678');
    expect(destinoOtp('sms', '8112345678', 'a@b.mx')).toBe('+52 81 1234 5678');
    expect(destinoOtp('email', '8112345678', ' Ana@Correo.MX ')).toBe('ana@correo.mx');
    expect(destinoOtp('email', '8112345678', '')).toBeNull();
  });
  it('mensajes legibles por código', () => {
    expect(mensajeError('WHATSAPP_INVALIDO')).toMatch(/SMS|correo/);
    expect(mensajeError('CANAL_NO_DISPONIBLE')).toMatch(/otro/);
    expect(mensajeError('OTP_INCORRECTO', { intentos_restantes: 2 })).toMatch(/2/);
    expect(mensajeError('DESCONOCIDO')).toMatch(/intenta/i);
  });
});

describe('WhatsApp de respaldo', () => {
  it('arma el mensaje con lo capturado y un link wa.me codificado', () => {
    const m = mensajeFallback({ vacante: 'Agente Smart', nombre: 'Ana', folio: null, horario: 'Mar 17 Nov 9:30 am', respuestas: [['Edad', '20']] });
    expect(m).toContain('Agente Smart');
    expect(m).toContain('Edad: 20');
    expect(linkWhatsApp('528119942627', 'a b&c')).toBe('https://wa.me/528119942627?text=a%20b%26c');
  });
});

describe('F7.4 · agenda por WhatsApp (sin PII de más)', () => {
  const EID = '0192f0a0-1234-7abc-8def-0123456789ab';
  it('referencia corta derivada del event_id del ClickCTA (correlación sin PII)', () => {
    expect(referenciaDe(EID)).toBe('WA-6789AB');
  });
  it('mensaje con vacante, nombre de pila y referencia; sin apellidos, teléfono, correo ni respuestas', () => {
    const m = mensajeAgendaWhatsApp({ vacante: 'Agente Smart', nombre: '  Mariana Garza López ', referencia: 'WA-6789AB' });
    expect(m).toBe('Hola Capital Humano 369, quiero agendar mi entrevista para la vacante Agente Smart.\nMi nombre: Mariana\nReferencia: WA-6789AB');
    expect(m).not.toMatch(/Garza|López|\d{10}|@/);
    expect(mensajeAgendaWhatsApp({ vacante: 'X', nombre: '', referencia: 'WA-1' })).not.toContain('Mi nombre');
  });
  it('link wa.me con el mensaje prellenado y codificado', () => {
    const l = linkAgendaWhatsApp('528119942627', { vacante: 'Agente Smart', nombre: 'Ana', eventId: EID });
    expect(l.startsWith('https://wa.me/528119942627?text=')).toBe(true);
    expect(decodeURIComponent(l.split('text=')[1]!)).toContain('Referencia: WA-6789AB');
  });
});

describe('cliente HTTP', () => {
  const respuesta = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  it('ok, error de negocio, fallback 5xx y error de red', async () => {
    const ok = crearClienteCaptacion('https://f', respuesta(201, { folio: 'x' }) as typeof fetch);
    expect(await ok.postular({})).toEqual({ tipo: 'ok', datos: { folio: 'x' } });
    const neg = crearClienteCaptacion('https://f', respuesta(409, { error: 'SLOT_LLENO', elegir_otro_horario: true }) as typeof fetch);
    expect(await neg.postular({})).toEqual({ tipo: 'error', status: 409, codigo: 'SLOT_LLENO', cuerpo: { error: 'SLOT_LLENO', elegir_otro_horario: true } });
    const caido = crearClienteCaptacion('https://f', respuesta(503, { error: 'X', fallback_whatsapp: true }) as typeof fetch);
    expect((await caido.postular({})).tipo).toBe('fallback');
    const red = crearClienteCaptacion('https://f', (async () => { throw new TypeError('offline'); }) as typeof fetch);
    expect((await red.verificarOtp('l', '123456')).tipo).toBe('fallback');
  });
  it('usa las rutas de las edge functions', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(String(u)); return new Response('{"slots":[]}', { status: 200 }); }) as unknown as typeof fetch;
    const c = crearClienteCaptacion('https://f/functions/v1', f);
    await c.obtenerSlots('agente-smart');
    await c.reenviarOtp('l', 'email', 'a@b.mx');
    await c.enviarContactoB2B({});
    expect(urls).toEqual(['https://f/functions/v1/citas-api?vacante=agente-smart', 'https://f/functions/v1/verificar-otp/reenviar', 'https://f/functions/v1/contacto-b2b']);
  });
});
