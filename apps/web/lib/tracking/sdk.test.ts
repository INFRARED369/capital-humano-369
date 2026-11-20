/* eslint-disable @typescript-eslint/no-explicit-any -- fakes de prueba con forma libre */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UUID_V7_RE } from '../../../../src/shared/ids';
import { eventoMeta } from '../../../../src/domains/tracking/domain/eventos';
import { crearTracker, depsNavegador, EVENTO_PIXEL, type DepsTracker } from './sdk';

const CLIENTE = '0b6f2c1e-6a43-4d34-9b8e-6d7c3a2f1e00';

function crearFakes(url = 'https://capitalhumano369.com/vacantes/agente-smart/?utm_source=facebook&utm_medium=paid&utm_campaign=nov&fbclid=IwAR42') {
  const jar = new Map<string, string>();
  const enviados: Array<Record<string, any>> = [];
  const scripts: string[] = [];
  const fbq = vi.fn();
  const clarity = vi.fn();
  const global: Record<string, any> = {};
  let enmascarado = false;
  const deps: DepsTracker = {
    config: { ingestUrl: 'https://f.test/tracking-ingest', pixelId: '111222333', clarityId: 'clar1', versionAviso: '2026-11-13' },
    cookies: {
      leer: (n) => jar.get(n) ?? null,
      escribir: (n, v) => void jar.set(n, v),
      borrar: (n) => void jar.delete(n),
    },
    ubicacion: () => new URL(url),
    referrer: () => 'https://www.google.com/search?q=empleo+ana%40x.com',
    enviar: (_u, cuerpo) => void enviados.push(JSON.parse(cuerpo)),
    cargarScript: (id, src) => {
      scripts.push(src);
      if (id === 'ch369-pixel') global.fbq = fbq;
      if (id === 'ch369-clarity') global.clarity = clarity;
    },
    marcarEnmascarado: () => { enmascarado = true; },
    global,
    ahora: () => new Date('2026-11-13T18:00:00Z'),
  };
  return { deps, jar, enviados, scripts, fbq, clarity, global, get enmascarado() { return enmascarado; } };
}

describe('TRK-01 / T4 · consentimiento', () => {
  let f: ReturnType<typeof crearFakes>;
  beforeEach(() => { f = crearFakes(); });

  it('sin decisión: no carga terceros, no crea cookies y retiene los eventos', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    expect(t.estadoConsentimiento()).toBeNull();
    t.track('PageView');
    expect(f.enviados).toEqual([]);
    expect(f.scripts).toEqual([]);
    expect([...f.jar.keys()]).toEqual([]);
  });

  it('T4 · rechazado: sin Clarity ni Pixel, sin cookies de marketing; solo conteo técnico anónimo', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    t.track('PageView');
    t.rechazar();
    t.track('ClickCTA', { cta: 'postular' });
    expect(f.scripts).toEqual([]);
    expect(f.global.fbq).toBeUndefined();
    expect(f.global.clarity).toBeUndefined();
    expect([...f.jar.keys()]).toEqual(['_369_consent']);
    expect(f.enviados.map((e) => e.nombre)).toEqual(['PageView', 'ClickCTA']);
    for (const e of f.enviados) {
      expect(e.consentimiento).toBe(false);
      expect(e).not.toHaveProperty('visitor_id');
      expect(e.atribucion).toEqual({ utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'nov', tiene_fbclid: true });
    }
    expect(t.obtenerAtribucion()).toEqual({ visitor_id: null });
    expect(t.tieneConsentimiento()).toBe(false);
  });

  it('aceptado: crea _369_vid/_fbp/_fbc, carga Clarity enmascarado y un solo Pixel; vacía la cola con consentimiento', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    const idPv = t.track('PageView');
    t.aceptar();
    expect(f.jar.get('_369_consent')).toBe('2026-11-13|a');
    expect(f.jar.get('_369_vid')).toMatch(UUID_V7_RE);
    expect(f.jar.get('_fbc')).toBe(`fb.1.${Date.parse('2026-11-13T18:00:00Z')}.IwAR42`);
    expect(f.jar.get('_fbp')).toMatch(/^fb\.1\.\d{13}\.\d{10}$/);
    expect(f.scripts).toEqual(['https://www.clarity.ms/tag/clar1', 'https://connect.facebook.net/en_US/fbevents.js']);
    expect(f.enmascarado).toBe(true);
    expect(f.clarity).toHaveBeenCalledWith('consent');
    expect(f.fbq.mock.calls.filter((c) => c[0] === 'init')).toEqual([['init', '111222333']]);
    expect(f.fbq).toHaveBeenCalledWith('set', 'autoConfig', false, '111222333');
    expect(f.enviados.map((e) => e.nombre)).toEqual(['ConsentAccepted', 'PageView']);
    const pv = f.enviados[1]!;
    expect(pv).toMatchObject({ v: 1, consentimiento: true, visitor_id: f.jar.get('_369_vid'), event_id: idPv, pagina: '/vacantes/agente-smart/', referrer: 'https://www.google.com' });
    expect(pv.atribucion).toMatchObject({ utm_source: 'facebook', fbclid: 'IwAR42', fbc: f.jar.get('_fbc'), fbp: f.jar.get('_fbp') });
    expect(t.tieneConsentimiento()).toBe(true);
    expect(t.obtenerAtribucion()).toMatchObject({ visitor_id: f.jar.get('_369_vid'), utm_campaign: 'nov', fbclid: 'IwAR42', landing: '/vacantes/agente-smart/' });
  });

  it('TRK-05 · el Pixel recibe el mismo event_id que el servidor y solo custom_data (sin PII)', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    t.aceptar();
    t.fijarContextoVacante({ vacancy_id: 'agente-smart', client_id: CLIENTE, content_category: 'ventas' });
    const id = t.track('ClickCTA', { cta: 'postular', correo: 'ana@x.com', tel: '81 1234 5678' });
    expect(id).toMatch(UUID_V7_RE);
    const enviado = f.enviados.at(-1)!;
    expect(enviado.event_id).toBe(id);
    expect(enviado.custom_data).toEqual({ vacancy_id: 'agente-smart', client_id: CLIENTE, content_category: 'ventas' });
    expect(enviado.props).toEqual({ cta: 'postular' });
    expect(f.fbq).toHaveBeenCalledWith('track', 'Contact', { vacancy_id: 'agente-smart', client_id: CLIENTE, content_category: 'ventas' }, { eventID: id });
    expect(JSON.stringify(f.fbq.mock.calls)).not.toMatch(/ana@x|1234/);
  });

  it('T8 · Schedule nunca sale del navegador; Lead solo al Pixel con el event_id del POST', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    t.aceptar();
    const n = f.enviados.length;
    const eid = '01934f6e-1c2a-7b3c-8d4e-5f6a7b8c9d0e';
    expect(t.track('LeadCreado', {}, eid)).toBe(eid);
    t.track('CitaConfirmada');
    t.track('WhatsAppVerificado');
    expect(f.enviados.length).toBe(n);
    expect(f.fbq).toHaveBeenCalledWith('track', 'Lead', expect.any(Object), { eventID: eid });
    expect(f.fbq.mock.calls.some((c) => c[1] === 'Schedule')).toBe(false);
  });

  it('decisión guardada: al recargar con consentimiento previo carga terceros sin banner', () => {
    f.jar.set('_369_consent', '2026-11-13|a');
    const t = crearTracker(f.deps);
    t.iniciar();
    expect(t.estadoConsentimiento()).toBe('aceptado');
    expect(f.scripts).toHaveLength(2);
    t.iniciar();
    expect(f.scripts).toHaveLength(2);
  });

  it('una versión nueva del aviso vuelve a pedir consentimiento', () => {
    f.jar.set('_369_consent', '2025-01-01|a');
    const t = crearTracker(f.deps);
    t.iniciar();
    expect(t.estadoConsentimiento()).toBeNull();
    expect(f.scripts).toEqual([]);
  });

  it('revocar borra cookies de marketing y avisa a Pixel y Clarity', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    t.aceptar();
    t.reabrir();
    expect(t.estadoConsentimiento()).toBeNull();
    t.rechazar();
    expect([...f.jar.keys()]).toEqual(['_369_consent']);
    expect(f.fbq).toHaveBeenCalledWith('consent', 'revoke');
    expect(f.clarity).toHaveBeenCalledWith('consent', false);
  });

  it('si nunca decide, al ocultar la página se envían como conteo anónimo', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    t.track('PageView');
    t.alOcultarPagina();
    t.alOcultarPagina();
    expect(f.enviados).toHaveLength(1);
    expect(f.enviados[0]!.consentimiento).toBe(false);
  });

  it('notifica a los suscriptores y sin Pixel/Clarity configurados no carga nada', () => {
    f.deps.config = { ...f.deps.config, pixelId: '', clarityId: '' };
    const t = crearTracker(f.deps);
    const oyente = vi.fn();
    const quitar = t.suscribir(oyente);
    t.iniciar();
    t.aceptar();
    expect(oyente).toHaveBeenCalled();
    quitar();
    t.rechazar();
    expect(oyente).toHaveBeenCalledTimes(2); // iniciar + aceptar; nada tras quitar
    expect(f.scripts).toEqual([]);
  });

  it('client_id no UUID se omite de custom_data (el servidor lo resuelve desde la vacante)', () => {
    const t = crearTracker(f.deps);
    t.iniciar();
    t.rechazar();
    t.fijarContextoVacante({ vacancy_id: 'agente-smart', client_id: 'cliente-x', content_category: 'ventas' });
    t.track('SectionView', { seccion: 'faq' });
    expect(f.enviados.at(-1)!.custom_data).toEqual({ vacancy_id: 'agente-smart', content_category: 'ventas' });
    t.fijarContextoVacante(null);
    t.track('SectionView');
    expect(f.enviados.at(-1)).not.toHaveProperty('custom_data');
  });

  it('atribución first-party persistida se reutiliza en visitas sin UTM', () => {
    const t1 = crearTracker(f.deps);
    t1.iniciar();
    t1.aceptar();
    const g = crearFakes('https://capitalhumano369.com/vacantes/agente-smart/');
    for (const [k, v] of f.jar) g.jar.set(k, v);
    const t2 = crearTracker(g.deps);
    t2.iniciar();
    t2.track('PageView');
    expect(g.enviados.at(-1)!.atribucion).toMatchObject({ utm_source: 'facebook', utm_campaign: 'nov' });
  });
});

describe('mapeo del Pixel coincide con el dominio (§8)', () => {
  it.each(Object.entries(EVENTO_PIXEL))('%s → %s', (interno, pixel) => {
    expect(eventoMeta(interno as never, {})?.nombre).toBe(pixel);
  });
});

describe('depsNavegador · adaptadores del navegador', () => {
  function ventanaFalsa(beacon: boolean) {
    const doc = {
      cookie: '',
      referrer: 'https://www.bing.com/',
      head: { appendChild: vi.fn() },
      documentElement: { setAttribute: vi.fn() },
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({}) as Record<string, unknown>),
    };
    const escritas: string[] = [];
    Object.defineProperty(doc, 'cookie', { get: () => 'a=1; _369_vid=abc; x=%7B%7D', set: (v: string) => void escritas.push(v) });
    const win = {
      document: doc,
      location: { href: 'https://capitalhumano369.com/' },
      navigator: { sendBeacon: vi.fn(() => beacon) },
      fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    };
    return { win, doc, escritas };
  }
  const cfg = { ingestUrl: 'https://f.test/i', pixelId: '', clarityId: '', versionAviso: 'v' };

  it('lee y escribe cookies first-party con SameSite=Lax y Secure', () => {
    const { win, escritas } = ventanaFalsa(true);
    const d = depsNavegador(cfg, win as never);
    expect(d.cookies.leer('_369_vid')).toBe('abc');
    expect(d.cookies.leer('x')).toBe('{}');
    expect(d.cookies.leer('nada')).toBeNull();
    d.cookies.escribir('_369_vid', 'v1', 30);
    d.cookies.borrar('_fbp');
    expect(escritas[0]).toMatch(/^_369_vid=v1; Max-Age=2592000; Path=\/; SameSite=Lax; Secure$/);
    expect(escritas[1]).toMatch(/^_fbp=; Max-Age=0/);
    expect(d.referrer()).toBe('https://www.bing.com/');
    expect(d.ubicacion().hostname).toBe('capitalhumano369.com');
  });

  it('usa sendBeacon como text/plain y cae a fetch keepalive si falla', () => {
    const a = ventanaFalsa(true);
    depsNavegador(cfg, a.win as never).enviar('https://f.test/i', '{}');
    expect(a.win.navigator.sendBeacon).toHaveBeenCalled();
    expect(a.win.fetch).not.toHaveBeenCalled();
    const b = ventanaFalsa(false);
    depsNavegador(cfg, b.win as never).enviar('https://f.test/i', '{}');
    expect(b.win.fetch).toHaveBeenCalledWith('https://f.test/i', expect.objectContaining({ method: 'POST', keepalive: true, credentials: 'omit' }));
  });

  it('carga scripts async una sola vez y enmascara el documento completo para Clarity', () => {
    const { win, doc } = ventanaFalsa(true);
    const d = depsNavegador(cfg, win as never);
    d.cargarScript('id1', 'https://x.test/a.js');
    expect(doc.head.appendChild).toHaveBeenCalledWith(expect.objectContaining({ src: 'https://x.test/a.js', async: true, id: 'id1' }));
    d.marcarEnmascarado();
    expect(doc.documentElement.setAttribute).toHaveBeenCalledWith('data-clarity-mask', 'true');
  });
});
