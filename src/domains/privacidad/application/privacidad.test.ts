/** Casos de uso de privacidad con dobles en memoria: retención diaria y ARCO (PRV-01, PRV-02, R8). */
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@shared/clock.ts';
import { hmacSha256Hex } from '@shared/crypto.ts';
import { crearLogger } from '@shared/logger.ts';
import { err, ok } from '@shared/result.ts';
import type { DepsPrivacidad, NuevaSolicitud, PrivacidadRepo, ResumenRetencion, SolicitudArco } from './puertos.ts';
import { ejecutarRetencionDiaria } from './retencion.ts';
import { consultarSolicitudArco, ejecutarSolicitudArco, listarSolicitudesArco, registrarSolicitudArco, responderSolicitudArco } from './arco.ts';

const PEPPER = 'pepper-de-prueba-de-32-caracteres!!';
const LEAD = '0190d3a0-0000-7000-8000-0000000000a1';

class RepoFalso implements PrivacidadRepo {
  solicitudes = new Map<string, NuevaSolicitud & { estado: SolicitudArco['estado']; cerradaEn: string | null }>();
  resumen: ResumenRetencion = { registroId: 1, omitida: false, dominios: ['captacion', 'citas', 'comunicacion', 'tracking'], faltantes: [], errores: {}, lotes: {}, conteos: { captacion: { leads: 2 } }, total: 2 };
  ejecutadas: string[] = [];
  async retencionDiaria() { return this.resumen; }
  async registrarSolicitud(s: NuevaSolicitud) {
    const id = `00000000-0000-4000-8000-00000000000${this.solicitudes.size + 1}`;
    this.solicitudes.set(id, { ...s, estado: 'recibida', cerradaEn: null });
    return id;
  }
  vista(id: string): SolicitudArco | null {
    const s = this.solicitudes.get(id);
    return s ? { id, tipo: s.tipo, canal: s.canal, estado: s.estado, recibidaEn: s.recibidaEn.toISOString(), limiteRespuesta: s.limiteRespuesta,
      limiteEjecucion: s.limiteEjecucion, cerradaEn: s.cerradaEn, leads: s.leads.length, resultado: null } : null;
  }
  async obtenerSolicitud(id: string) { return this.vista(id); }
  async listarSolicitudes(f: { estado?: SolicitudArco['estado'] }) {
    return [...this.solicitudes.keys()].map((id) => this.vista(id)!).filter((s) => !f.estado || s.estado === f.estado);
  }
  async ejecutarSolicitud(id: string, ahora: Date) {
    const s = this.solicitudes.get(id);
    if (!s) return err('NO_ENCONTRADA' as const);
    if (s.estado !== 'recibida') return err('TRANSICION_INVALIDA' as const);
    s.estado = 'ejecutada';
    s.cerradaEn = ahora.toISOString();
    this.ejecutadas.push(id);
    return ok({ conteos: { leads: s.leads.length, opt_out: s.telefonoHmac ? 1 : 0 }, faltantes: [] });
  }
  async responderSolicitud(id: string, estado: 'respondida' | 'rechazada', _m: string, ahora: Date) {
    const s = this.solicitudes.get(id);
    if (!s) return err('NO_ENCONTRADA' as const);
    if (s.estado !== 'recibida') return err('TRANSICION_INVALIDA' as const);
    s.estado = estado;
    s.cerradaEn = ahora.toISOString();
    return ok(undefined);
  }
}

function deps(o: Partial<DepsPrivacidad> = {}) {
  const logs: string[] = [];
  const repo = new RepoFalso();
  const d: DepsPrivacidad = {
    repo,
    contactos: { telefonoDeLead: async (id) => (id === LEAD ? '528112345678' : null) },
    clock: new FixedClock(new Date('2026-11-17T18:00:00Z')),
    logger: crearLogger({ funcion: 'prueba' }, (l) => logs.push(l)),
    pepper: PEPPER,
    ...o,
  };
  return { d, repo, logs };
}

describe('ejecutarRetencionDiaria', () => {
  it('delega en el repo con la hora del reloj y registra solo conteos', async () => {
    const { d, logs } = deps();
    const r = await ejecutarRetencionDiaria(d);
    expect(r.total).toBe(2);
    expect(logs.join('\n')).toContain('retencion_diaria');
  });
  it('avisa (warn) si hay dominios faltantes o con error', async () => {
    const { d, repo, logs } = deps();
    repo.resumen = { ...repo.resumen, faltantes: ['tracking'], errores: { citas: 'P0001' } };
    await ejecutarRetencionDiaria(d);
    const l = logs.map((x) => JSON.parse(x) as { nivel: string; msg: string });
    expect(l.some((x) => x.nivel === 'warn' && x.msg === 'retencion_incompleta')).toBe(true);
  });
  it('informa si otra corrida tenía el candado', async () => {
    const { d, repo, logs } = deps();
    repo.resumen = { ...repo.resumen, omitida: true };
    expect((await ejecutarRetencionDiaria(d)).omitida).toBe(true);
    expect(logs.join()).toContain('retencion_omitida');
  });
});

describe('registrarSolicitudArco', () => {
  it('por teléfono: guarda solo el HMAC normalizado y los plazos de 20 días hábiles', async () => {
    const { d, repo, logs } = deps();
    const r = await registrarSolicitudArco(d, { tipo: 'cancelacion', canal: 'correo', telefono: '+52 (81) 1234-5678' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ limiteRespuesta: '2026-12-15', limiteEjecucion: '2027-01-07', ejecucion: null });
    const s = repo.solicitudes.get(r.value.solicitudId)!;
    expect(s.telefonoHmac).toBe(await hmacSha256Hex(PEPPER, '528112345678'));
    expect(JSON.stringify(s)).not.toContain('8112345678');
    expect(logs.join()).not.toMatch(/8112345678|1234-5678/);
  });
  it('por lead: obtiene el teléfono con captación para el opt-out (sin guardarlo)', async () => {
    const { d, repo } = deps();
    const r = await registrarSolicitudArco(d, { tipo: 'revocacion', canal: 'formulario', leadId: LEAD });
    expect(r.ok && repo.solicitudes.get(r.value.solicitudId)).toMatchObject({ leads: [LEAD], telefonoHmac: await hmacSha256Hex(PEPPER, '528112345678') });
  });
  it('lead ya suprimido: se registra sin HMAC', async () => {
    const { d, repo } = deps();
    const otro = '0190d3a0-0000-7000-8000-0000000000ff';
    const r = await registrarSolicitudArco(d, { tipo: 'cancelacion', canal: 'correo', leadId: otro });
    expect(r.ok && repo.solicitudes.get(r.value.solicitudId)).toMatchObject({ leads: [otro], telefonoHmac: null });
  });
  it('revocación con ejecutar=true: se ejecuta al instante (§3)', async () => {
    const { d, repo } = deps();
    const r = await registrarSolicitudArco(d, { tipo: 'revocacion', canal: 'whatsapp', telefono: '8112345678', ejecutar: true });
    expect(r.ok && r.value.ejecucion).toEqual({ conteos: { leads: 0, opt_out: 1 }, faltantes: [] });
    expect(repo.ejecutadas).toHaveLength(1);
  });
  it('acceso con ejecutar=true no suprime nada', async () => {
    const { d, repo } = deps();
    const r = await registrarSolicitudArco(d, { tipo: 'acceso', canal: 'correo', telefono: '8112345678', ejecutar: true });
    expect(r.ok && r.value.ejecucion).toBeNull();
    expect(repo.ejecutadas).toHaveLength(0);
  });
  it('errores de entrada', async () => {
    const { d } = deps();
    expect(await registrarSolicitudArco(d, { tipo: 'cancelacion', canal: 'correo' })).toEqual({ ok: false, error: 'SIN_IDENTIFICADOR' });
    expect(await registrarSolicitudArco(d, { tipo: 'cancelacion', canal: 'correo', telefono: '123' })).toEqual({ ok: false, error: 'TELEFONO_INVALIDO' });
    expect(await registrarSolicitudArco(d, { tipo: 'cancelacion', canal: 'correo', leadId: 'no-uuid' })).toEqual({ ok: false, error: 'LEAD_INVALIDO' });
    expect(await registrarSolicitudArco(d, { tipo: 'cancelacion', canal: 'correo', telefono: '8112345678', recibidaEn: '2026-12-01T00:00:00Z' }))
      .toEqual({ ok: false, error: 'FECHA_INVALIDA' });
  });
  it('acepta la fecha de recepción real (p. ej. el correo llegó antes de capturarlo)', async () => {
    const { d } = deps();
    const r = await registrarSolicitudArco(d, { tipo: 'acceso', canal: 'correo', telefono: '8112345678', recibidaEn: '2026-11-13T18:00:00Z' });
    expect(r.ok && r.value.limiteRespuesta).toBe('2026-12-14');
  });
});

describe('ejecutar, responder, consultar y listar', () => {
  it('ejecutar valida la transición en el dominio antes de tocar la BD', async () => {
    const { d, repo } = deps();
    const acceso = await registrarSolicitudArco(d, { tipo: 'acceso', canal: 'correo', telefono: '8112345678' });
    if (!acceso.ok) throw new Error();
    expect(await ejecutarSolicitudArco(d, acceso.value.solicitudId)).toEqual({ ok: false, error: 'TIPO_NO_EJECUTABLE' });
    expect(repo.ejecutadas).toHaveLength(0);
    expect(await ejecutarSolicitudArco(d, '00000000-0000-4000-8000-0000000000aa')).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
  });
  it('responder cierra la solicitud; una segunda vez es transición inválida', async () => {
    const { d } = deps();
    const r = await registrarSolicitudArco(d, { tipo: 'acceso', canal: 'correo', telefono: '8112345678' });
    if (!r.ok) throw new Error();
    expect(await responderSolicitudArco(d, r.value.solicitudId, 'respondida', 'datos_entregados')).toEqual({ ok: true, value: undefined });
    expect(await responderSolicitudArco(d, r.value.solicitudId, 'rechazada', 'x')).toEqual({ ok: false, error: 'TRANSICION_INVALIDA' });
    expect(await responderSolicitudArco(d, '00000000-0000-4000-8000-0000000000aa', 'rechazada', 'x')).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
  });
  it('consultar y listar agregan el vencimiento', async () => {
    const { d } = deps();
    const r = await registrarSolicitudArco(d, { tipo: 'acceso', canal: 'correo', telefono: '8112345678' });
    if (!r.ok) throw new Error();
    const c = await consultarSolicitudArco(d, r.value.solicitudId);
    expect(c).toMatchObject({ ok: true, value: { estado: 'recibida', vencimiento: 'en_plazo' } });
    expect(await consultarSolicitudArco(d, '00000000-0000-4000-8000-0000000000aa')).toEqual({ ok: false, error: 'NO_ENCONTRADA' });
    const l = await listarSolicitudesArco(d, { estado: 'recibida' });
    expect(l).toHaveLength(1);
    expect(l[0]!.vencimiento).toBe('en_plazo');
  });
});
