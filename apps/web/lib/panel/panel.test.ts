import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../src/shared/clock';
import { PLANTILLA_VACANTE_DEFECTO, ReglasVacanteSchema } from '../../../../src/domains/vacantes';
import { rutaCita, leerIdCita, leerToken } from './rutas';
import { puedeEditarCalendario, puedeEditarReglas, puedeOperar, resumirPerfil } from './roles';
import { asignar, bloqueoDesdeFormulario, localAIso, problemasPorCampo, textoAFechas, textoAVentanas, ventanasATexto, vistaPrevia } from './editor';
import { combinarAgenda, evaluacionDesdeFormulario, formatearHora, hoyLocal, puedeRegistrarAsistencia, mensajeErrorAsistencia } from './agenda';
import { crearClienteFunciones, mensajePanel } from './funciones';

const ID = '0192f0a0-0000-7000-8000-0000000000c1';
const VA = 'a0000000-0000-4000-8000-000000000001';
const VB = 'b0000000-0000-4000-8000-000000000001';

describe('rutas: id de la cita desde el link de Zoho (CIT-10) y token de gestión (CIT-11)', () => {
  it('acepta ?id=, #id=, #<uuid> y /panel/citas/<uuid>/ (formato actual de Zoho)', () => {
    expect(leerIdCita({ search: `?id=${ID}`, hash: '', pathname: '/panel/citas/' })).toBe(ID);
    expect(leerIdCita({ search: '', hash: `#id=${ID}`, pathname: '/panel/citas/' })).toBe(ID);
    expect(leerIdCita({ search: '', hash: `#${ID.toUpperCase()}`, pathname: '/panel/citas/' })).toBe(ID);
    expect(leerIdCita({ search: '', hash: '', pathname: `/panel/citas/${ID}/` })).toBe(ID);
    expect(leerIdCita({ search: '?id=../../x', hash: '', pathname: '/panel/citas/' })).toBeNull();
    expect(rutaCita(ID)).toBe(`/panel/citas/?id=${ID}`);
  });

  it('token: ?t= o ?token=, acotado', () => {
    expect(leerToken('?t=abc.def')).toBe('abc.def');
    expect(leerToken('?token=abc')).toBe('abc');
    expect(leerToken('')).toBeNull();
    expect(leerToken(`?t=${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('roles (DSH-06)', () => {
  const admin = resumirPerfil('u1', 'a@x.mx', [{ rol: 'admin' }], []);
  const recl = resumirPerfil('u2', 'r@x.mx', [{ rol: 'reclutador' }], [{ vacante_id: VA }]);
  const cli = resumirPerfil('u3', 'c@x.mx', [{ rol: 'cliente' }], [{ vacante_id: VA }]);

  it('admin opera y edita todo, incluido el calendario', () => {
    expect([puedeOperar(admin, VB), puedeEditarReglas(admin, VB), puedeEditarCalendario(admin)]).toEqual([true, true, true]);
  });
  it('reclutador solo sus vacantes y sin cambiar el calendario', () => {
    expect([puedeOperar(recl, VA), puedeOperar(recl, VB), puedeEditarReglas(recl, VA), puedeEditarCalendario(recl)]).toEqual([true, false, true, false]);
  });
  it('S3: cliente solo lectura', () => {
    expect([puedeOperar(cli, VA), puedeEditarReglas(cli, VA)]).toEqual([false, false]);
    expect(cli.etiqueta).toBe('Cliente (solo lectura)');
  });
});

describe('editor de reglas (DSH-04)', () => {
  it('ventanas ↔ texto', () => {
    expect(ventanasATexto(PLANTILLA_VACANTE_DEFECTO.agenda.ventanas_inicio)).toBe('09:30-13:00, 15:00-17:00');
    expect(textoAVentanas(' 09:30 - 13:00 ,15:00-17:00')).toEqual({ ok: true, value: [{ desde: '09:30', hasta: '13:00' }, { desde: '15:00', hasta: '17:00' }] });
    expect(textoAVentanas('9-13').ok).toBe(false);
    expect(textoAVentanas('').ok).toBe(false);
  });

  it('fechas (festivos) desde texto libre separado por comas o saltos', () => {
    expect(textoAFechas('2026-12-25,\n2027-01-01  ')).toEqual({ ok: true, value: ['2026-12-25', '2027-01-01'] });
    expect(textoAFechas('')).toEqual({ ok: true, value: [] });
    expect(textoAFechas('25/12/2026').ok).toBe(false);
  });

  it('asignar es inmutable y crea la ruta', () => {
    const r = asignar(PLANTILLA_VACANTE_DEFECTO, 'agenda.cupo_diario', 5);
    expect(r.agenda.cupo_diario).toBe(5);
    expect(PLANTILLA_VACANTE_DEFECTO.agenda.cupo_diario).toBe(10);
    expect(asignar({}, 'a.b', 1)).toEqual({ a: { b: 1 } });
    expect(asignar(r, 'zoho_calendar_uid', undefined)).not.toHaveProperty('zoho_calendar_uid');
  });

  it('vista previa: slots de los próximos días con generarSlots (puro, en el navegador)', () => {
    const clock = new FixedClock(new Date('2026-11-17T02:00:00Z')); // lunes 20:00 CDMX
    const p = vistaPrevia(PLANTILLA_VACANTE_DEFECTO, clock, 3);
    expect(p.map((d) => d.fecha)).toEqual(['2026-11-17', '2026-11-18', '2026-11-19']);
    expect(p[0]!.horas).toHaveLength(13);
    expect(p[0]!.etiqueta).toMatch(/17/);
    const corta = vistaPrevia(ReglasVacanteSchema.parse({ agenda: { cupo_diario: 5, ventanas_inicio: [{ desde: '09:30', hasta: '10:30' }], capacidad_por_slot: 2 } }), clock, 1);
    expect(corta[0]).toMatchObject({ horas: ['09:30', '10:00', '10:30'], capacidad: 2, cupo: 5 });
  });

  it('bloqueo manual: hora local de la vacante → ISO UTC; valida orden y formato', () => {
    expect(bloqueoDesdeFormulario({ fecha: '2026-11-18', desde: '09:30', hasta: '11:00', motivo: ' junta ' }, 'America/Mexico_City')).toEqual({
      ok: true, value: { desde: '2026-11-18T15:30:00.000Z', hasta: '2026-11-18T17:00:00.000Z', motivo: 'junta' },
    });
    expect(localAIso('2026-07-01', '10:00', 'America/Tijuana')).toBe('2026-07-01T17:00:00.000Z'); // con horario de verano
    expect(bloqueoDesdeFormulario({ fecha: '2026-11-18', desde: '11:00', hasta: '09:00', motivo: '' }, 'America/Mexico_City').ok).toBe(false);
    expect(bloqueoDesdeFormulario({ fecha: 'x', desde: '09:00', hasta: '10:00', motivo: '' }, 'America/Mexico_City').ok).toBe(false);
    // y el bloqueo resultante lo acepta el esquema y excluye esos inicios de la vista previa
    const b = bloqueoDesdeFormulario({ fecha: '2026-11-17', desde: '09:30', hasta: '12:00', motivo: '' }, 'America/Mexico_City');
    const r = ReglasVacanteSchema.parse({ agenda: { bloqueos: [b.ok ? b.value : null] } });
    expect(vistaPrevia(r, new FixedClock(new Date('2026-11-17T02:00:00Z')), 1)[0]!.horas[0]).toBe('12:00');
  });

  it('problemas por campo (el primero gana)', () => {
    expect(problemasPorCampo([{ ruta: 'agenda.cupo_diario', mensaje: 'a' }, { ruta: 'agenda.cupo_diario', mensaje: 'b' }, { ruta: '', mensaje: 'c' }])).toEqual({ 'agenda.cupo_diario': 'a', '': 'c' });
  });
});

describe('agenda y asistencia (DSH-05, CIT-10)', () => {
  it('combina citas con folio y nombre de pila, ordena por hora y formatea en la zona', () => {
    const items = combinarAgenda(
      [
        { id: 'c2', vacante_id: VA, inicio: '2026-11-17T16:30:00Z', fin: '2026-11-17T18:00:00Z', estado: 'confirmada', asistio: null, evaluacion: null, lead_id: 'l2' },
        { id: 'c1', vacante_id: VA, inicio: '2026-11-17T16:00:00Z', fin: '2026-11-17T17:30:00Z', estado: 'asistio', asistio: true, evaluacion: { calificacion: 4 }, lead_id: 'l1' },
        { id: 'c3', vacante_id: VA, inicio: '2026-11-17T17:00:00Z', fin: '2026-11-17T18:30:00Z', estado: 'cancelada', asistio: null, evaluacion: null, lead_id: null },
      ],
      [{ id: 'l1', folio: '369-AAAAAA', nombre_pila: 'Ana' }, { id: 'l2', folio: '369-BBBBBB', nombre_pila: 'Luis' }],
      'America/Mexico_City',
    );
    expect(items.map((i) => [i.id, i.hora, i.folio, i.nombrePila])).toEqual([
      ['c1', '10:00', '369-AAAAAA', 'Ana'],
      ['c2', '10:30', '369-BBBBBB', 'Luis'],
      ['c3', '11:00', '—', 'Candidato'],
    ]);
    expect(items[0]!.etiquetaEstado).toBe('Asistió');
  });

  it('hoyLocal y formatearHora usan la zona de la vacante', () => {
    expect(hoyLocal(new FixedClock(new Date('2026-11-17T05:00:00Z')), 'America/Mexico_City')).toBe('2026-11-16');
    expect(formatearHora('2026-11-17T16:00:00Z', 'America/Mexico_City')).toBe('10:00');
  });

  it('se registra asistencia en confirmada y se reevalúa en asistió/no asistió; nada más', () => {
    expect(['confirmada', 'asistio', 'no_asistio', 'cancelada', 'retenida'].map(puedeRegistrarAsistencia)).toEqual([true, true, true, false, false]);
  });

  it('evaluación estructurada y acotada; vacía → null', () => {
    expect(evaluacionDesdeFormulario({ calificacion: '4', recomendacion: 'avanzar', notas: '  buena actitud ' })).toEqual({ ok: true, value: { calificacion: 4, recomendacion: 'avanzar', notas: 'buena actitud' } });
    expect(evaluacionDesdeFormulario({ calificacion: '', recomendacion: '', notas: '' })).toEqual({ ok: true, value: null });
    expect(evaluacionDesdeFormulario({ calificacion: '9', recomendacion: '', notas: '' }).ok).toBe(false);
    expect(evaluacionDesdeFormulario({ calificacion: '', recomendacion: '', notas: 'x'.repeat(1001) }).ok).toBe(false);
  });

  it('mensajes de error de registrar_asistencia', () => {
    expect(mensajeErrorAsistencia('PERMISO_DENEGADO')).toMatch(/permiso/i);
    expect(mensajeErrorAsistencia('TRANSICION_INVALIDA: cancelada -> asistio')).toMatch(/estado/i);
    expect(mensajeErrorAsistencia('otra cosa')).toMatch(/No se pudo/);
  });
});

describe('cliente de funciones del panel (panel-reglas)', () => {
  it('manda Bearer y JSON; clasifica ok / error con código y problemas / red', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ version: 2 }), { status: 200 }));
    const c = crearClienteFunciones('https://p.supabase.co/functions/v1/', f, async () => 'jwt');
    expect(await c.panelReglas('guardar_reglas', { a: 1 })).toEqual({ tipo: 'ok', datos: { version: 2 } });
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://p.supabase.co/functions/v1/panel-reglas');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer jwt');
    expect(JSON.parse(String(init.body))).toEqual({ operacion: 'guardar_reglas', datos: { a: 1 } });

    const c2 = crearClienteFunciones('https://p', async () => new Response(JSON.stringify({ error: 'REGLAS_INVALIDAS', problemas: [{ ruta: 'x', mensaje: 'm' }] }), { status: 422 }), async () => 'jwt');
    expect(await c2.panelReglas('guardar_reglas', {})).toEqual({ tipo: 'error', status: 422, codigo: 'REGLAS_INVALIDAS', problemas: [{ ruta: 'x', mensaje: 'm' }] });
    const c3 = crearClienteFunciones('https://p', async () => { throw new Error('red'); }, async () => 'jwt');
    expect(await c3.panelReglas('crear_cliente', {})).toEqual({ tipo: 'error', status: 0, codigo: 'RED', problemas: [] });
    const c4 = crearClienteFunciones('https://p', f, async () => null);
    expect(await c4.panelReglas('crear_cliente', {})).toEqual({ tipo: 'error', status: 401, codigo: 'SIN_SESION', problemas: [] });
  });

  it('mensajes para cada código', () => {
    for (const c of ['PERMISO_DENEGADO', 'VERSION_CONFLICTO', 'REGLAS_INVALIDAS', 'SIN_SESION', 'DUPLICADO', 'RED', 'X']) expect(mensajePanel(c).length).toBeGreaterThan(5);
  });
});
