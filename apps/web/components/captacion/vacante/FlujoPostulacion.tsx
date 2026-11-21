'use client';
/**
 * Flujo del candidato (CAP-03, CAP-06, CAP-08, CAP-10, D4, D11):
 * datos + preguntas + consentimiento → horario (citas-api) + anti-bot → postular → OTP → pase con folio.
 * Sin filtro ni descalificación. Si cualquier backend falla, se ofrece WhatsApp con lo capturado.
 * El código se recibe por WhatsApp, SMS o correo (elegible antes de enviar y cambiable en cada reenvío);
 * el número o correo de destino siempre está visible.
 * Si el candidato recarga, vuelve al mismo paso con los mismos datos (sessionStorage, lib/captacion/persistencia).
 * F7.4: si citas-api responde `agenda_modo: 'whatsapp'`, tras los datos se lleva al candidato a WhatsApp
 * (wa.me con vacante, nombre de pila y referencia; ClickCTA) sin pantalla de horarios.
 * Nada de PII viaja al tracking: solo nombres de evento, ids y el event_id del Lead.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import type { Pregunta } from '../../../../../src/domains/captacion';
import { crearClienteCaptacion } from '../../../lib/captacion/api';
import { CANALES_OTP, ETIQUETA_CANAL, destinoOtp, estadoInicial, mensajeError, reducir, type CanalOtp } from '../../../lib/captacion/flujo';
import { construirPostulacion, erroresPorCampo, precargarValidador, type ErroresCampo, type ValoresFormulario } from '../../../lib/captacion/formulario';
import { borrarAvance, guardarAvance, hayAvance, leerAvance } from '../../../lib/captacion/persistencia';
import { formatearCita, interpretarAgenda, type DecisionAgenda, type DiaSlots } from '../../../lib/captacion/slots';
import { linkAgendaWhatsApp, linkWhatsApp, mensajeFallback } from '../../../lib/captacion/whatsapp';
import { uuidv7 } from '../../../../../src/shared/ids';
import { configPublica } from '../../../lib/config';
import { obtenerAtribucion, track } from '../../../lib/tracking';
import { Turnstile } from '../Turnstile';
import { IMG } from '../../../lib/captacion/recursos';

export interface PropsFlujo {
  slug: string;
  vacante: string;
  zonaHoraria: string;
  preguntas: Pregunta[];
  pasos: string[];
  whatsapp: { numero: string; etiqueta: string; atencion: string };
  pase: { vacante: string; atencion: string; direccion: string; documentos: string[] };
}

const SLOT_DUMMY = '2000-01-01T00:00:00.000Z';
const CAMPOS_PASO_HORARIO = new Set(['slot_inicio', 'turnstile_token', 'event_id', 'vacante']);
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TITULO_CANAL: Record<CanalOtp, string> = { whatsapp: 'WhatsApp', sms: 'SMS (mensaje de texto)', email: 'Correo electrónico' };
const VERIFICADO: Record<CanalOtp, string> = { whatsapp: 'WHATSAPP', sms: 'CELULAR', email: 'CORREO' };

export function FlujoPostulacion(p: PropsFlujo) {
  const api = useRef(crearClienteCaptacion(configPublica.funcionesUrl)).current;
  const [s, enviar] = useReducer(reducir, estadoInicial);
  const [valores, setValores] = useState<ValoresFormulario>({ nombre: '', telefono: '', email: '', respuestas: {} });
  const [consentido, setConsentido] = useState(false);
  const [errores, setErrores] = useState<ErroresCampo>({});
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [dias, setDias] = useState<DiaSlots[] | null>(null);
  const [dia, setDia] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [reinicioTurnstile, setReinicioTurnstile] = useState(0);
  const [codigo, setCodigo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [iniciado, setIniciado] = useState(false);
  // Canal elegido para el próximo envío del código (paso de horario) y edición del correo en el paso OTP.
  const [canal, setCanal] = useState<CanalOtp>('whatsapp');
  const [editandoEmail, setEditandoEmail] = useState(false);
  // No se guarda nada hasta haber intentado recuperar el avance (si no, el estado inicial lo borraría).
  const [recuperado, setRecuperado] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  // event_id del ClickCTA de la agenda por WhatsApp: su referencia corta viaja en el mensaje (correlación sin PII).
  const [eventoAgenda] = useState(uuidv7);

  // Lleva el foco al título de cada paso (lectores de pantalla y móvil). Al montar NO: robaría el foco al cargar la
  // página y, como el foco cae dentro del <form>, dispararía onFocus → FormStarted y la carga del validador sin que
  // el candidato haya tocado nada. Al recuperar un avance sí se mueve (cambia `s.paso`).
  const montado = useRef(false);
  useEffect(() => {
    if (!montado.current) {
      montado.current = true;
      return;
    }
    raiz.current?.querySelector<HTMLElement>('[data-foco]')?.focus();
  }, [s.paso]);

  /**
   * Consulta citas-api y decide la pantalla (F7.4). Devuelve true si hay que mostrar los horarios.
   * `previo` (al recuperar el avance) conserva el día y la hora elegidos si siguen disponibles.
   */
  const cargarSlots = useCallback(async (previo?: { dia: string | null; slot: string | null }): Promise<boolean> => {
    setDias(null);
    setSlot(null);
    const a: DecisionAgenda = interpretarAgenda(await api.obtenerSlots(p.slug));
    if (a.tipo === 'fallback') return (enviar({ tipo: 'fallback' }), false);
    if (a.tipo === 'whatsapp') return (enviar({ tipo: 'agenda_whatsapp' }), false);
    setDias(a.dias);
    const diaPrevio = a.dias.find((d) => d.fecha === previo?.dia);
    setDia(diaPrevio?.fecha ?? a.dias[0]?.fecha ?? null);
    if (diaPrevio?.horas.some((h) => h.inicio === previo?.slot)) setSlot(previo!.slot);
    return true;
  }, [api, p.slug]);

  // Al montar: recupera el avance guardado (mismo paso y mismos datos). Solo en el navegador, tras hidratar.
  useEffect(() => {
    const a = leerAvance(p.slug);
    if (a) {
      setValores(a.valores);
      setConsentido(a.consentido);
      setCanal(a.canal);
      setDia(a.dia);
      setSlot(a.slot);
      setIniciado(true);
      enviar({ tipo: 'restaurar', estado: a.estado });
      if (a.estado.paso === 'horario') void cargarSlots({ dia: a.dia, slot: a.slot });
      if (a.estado.paso !== 'formulario') setMensaje('Recuperamos tu avance: continúa donde te quedaste.');
    }
    setRecuperado(true);
    // Solo una vez al montar (cargarSlots es estable: depende de api y slug).
  }, []);

  // Guarda el avance en cada cambio (sin token anti-bot ni código OTP).
  useEffect(() => {
    if (!recuperado) return;
    const avance = { estado: s, valores, consentido, canal, dia, slot };
    if (hayAvance(avance)) guardarAvance(p.slug, avance);
    else borrarAvance(p.slug);
  }, [recuperado, p.slug, s, valores, consentido, canal, dia, slot]);

  const elegirOtroHorario = (mensajeAviso: string) => {
    enviar({ tipo: 'elegir_otro_horario', mensaje: mensajeAviso });
    void cargarSlots();
  };

  const etiquetaRespuesta = (q: Pregunta, v: string) => (q.tipo === 'opcion' ? (q.opciones.find((o) => o.valor === v)?.etiqueta ?? v) : v);
  const horarioElegido = () => (slot ? formatearCita(slot, p.zonaHoraria) : null);
  const textoFallback = () =>
    mensajeFallback({
      vacante: p.vacante, nombre: valores.nombre, folio: s.folio, horario: horarioElegido(),
      respuestas: p.preguntas.filter((q) => valores.respuestas[q.id]).map((q) => [q.etiqueta.replace(/^\d+\.\s*/, ''), etiquetaRespuesta(q, valores.respuestas[q.id]!)]),
    });

  function iniciar() {
    if (iniciado) return;
    setIniciado(true);
    void precargarValidador();
    track('FormStarted', { form_id: 'postulacion' });
  }

  async function validarDatos(e: FormEvent) {
    e.preventDefault();
    const r = await construirPostulacion({ slug: p.slug, preguntas: p.preguntas, valores, slotInicio: SLOT_DUMMY, versionAviso: configPublica.versionAviso, consentido, turnstileToken: 'x', atribucion: {} });
    const errs: ErroresCampo = 'error' in r ? Object.fromEntries(Object.entries(r.error).filter(([k]) => !CAMPOS_PASO_HORARIO.has(k))) : {};
    setErrores(errs);
    if (Object.keys(errs).length) {
      setMensaje('Revisa los campos marcados.');
      const primero = Object.keys(errs)[0]!;
      document.getElementById(`campo-${primero.replace('respuestas.', '')}`)?.focus();
      return;
    }
    setMensaje(null);
    // El modo de agenda se conoce ANTES de cambiar de pantalla: en modo WhatsApp no se muestra la de horarios.
    setOcupado(true);
    const horarios = await cargarSlots();
    setOcupado(false);
    if (horarios) enviar({ tipo: 'datos_listos' });
  }

  async function postular() {
    if (!slot) return setMensaje('Elige un día y una hora.');
    if (!token) return setMensaje(mensajeError('ANTIBOT_REQUERIDO'));
    const cuerpo = await construirPostulacion({
      slug: p.slug, preguntas: p.preguntas, valores, slotInicio: slot, versionAviso: configPublica.versionAviso, consentido, turnstileToken: token, canalOtp: canal,
      atribucion: obtenerAtribucion() as unknown as Record<string, unknown>,
    });
    if ('error' in cuerpo) {
      setErrores(cuerpo.error);
      // Solo falta o está mal el correo para recibir el código: se corrige aquí mismo, sin volver al formulario.
      if (canal === 'email' && Object.keys(cuerpo.error).every((k) => k === 'email')) return setMensaje(cuerpo.error.email ?? mensajeError('EMAIL_REQUERIDO'));
      return enviar({ tipo: 'volver' });
    }
    setOcupado(true);
    setMensaje(null);
    track('FormSubmitted', { form_id: 'postulacion' });
    const r = await api.postular(cuerpo.value);
    setOcupado(false);
    setToken('');
    setReinicioTurnstile((n) => n + 1);
    if (r.tipo === 'ok') {
      const d = r.datos as { lead_id: string; folio: string; otp: { expira_en: string; reenvios_restantes: number; canal?: CanalOtp } };
      // Lead (Pixel) con el MISMO event_id que viaja al servidor → deduplicación con CAPI (TRK-05).
      track('LeadCreado', {}, cuerpo.value.event_id);
      setCodigo('');
      return enviar({ tipo: 'postulado', leadId: d.lead_id, folio: d.folio, expiraEn: d.otp.expira_en, reenviosRestantes: d.otp.reenvios_restantes, canal: d.otp.canal ?? canal });
    }
    if (r.tipo === 'fallback') return enviar({ tipo: 'fallback' });
    // Sin WhatsApp en ese número: se queda en este paso y propone SMS (o correo) en lugar de cerrar la puerta.
    if (r.codigo === 'WHATSAPP_INVALIDO') {
      setCanal('sms');
      return setMensaje(mensajeError(r.codigo));
    }
    if (r.codigo === 'CANAL_NO_DISPONIBLE' || r.codigo === 'EMAIL_REQUERIDO') return setMensaje(mensajeError(r.codigo));
    if (r.cuerpo.elegir_otro_horario) {
      void cargarSlots();
      return setMensaje(mensajeError(r.codigo));
    }
    if (r.codigo === 'FORMATO_INVALIDO' || r.codigo === 'CONSENTIMIENTO_REQUERIDO') {
      const campos = Array.isArray(r.cuerpo.campos) ? erroresPorCampo(r.cuerpo.campos as Array<{ campo: string; mensaje: string }>) : {};
      if (r.codigo === 'CONSENTIMIENTO_REQUERIDO') campos.consentimiento = mensajeError(r.codigo);
      setErrores(campos);
      setMensaje(mensajeError(r.codigo));
      return enviar({ tipo: 'volver' });
    }
    setMensaje(mensajeError(r.codigo, r.cuerpo) + (r.codigo === 'YA_POSTULADO' && typeof r.cuerpo.folio === 'string' ? ` Tu folio: ${r.cuerpo.folio}.` : ''));
  }

  async function verificar(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(codigo)) return setMensaje('Escribe los 6 dígitos del código.');
    if (!s.leadId) return;
    setOcupado(true);
    const r = await api.verificarOtp(s.leadId, codigo);
    setOcupado(false);
    if (r.tipo === 'ok') {
      const d = r.datos as { cita: { inicio: string; fin: string } };
      setMensaje(null);
      return enviar({ tipo: 'verificado', inicio: d.cita.inicio, fin: d.cita.fin });
    }
    if (r.tipo === 'fallback') return enviar({ tipo: 'fallback' });
    if (r.codigo === 'YA_VERIFICADO') return enviar({ tipo: 'verificado', inicio: slot ?? '', fin: '' });
    if (r.cuerpo.elegir_otro_horario) return elegirOtroHorario(mensajeError(r.codigo));
    if (r.codigo === 'OTP_BLOQUEADO' || r.codigo === 'NO_ENCONTRADO') {
      setMensaje(mensajeError(r.codigo));
      return;
    }
    setCodigo('');
    setMensaje(mensajeError(r.codigo, r.cuerpo));
  }

  /** Reenvía el código por el canal elegido (puede ser distinto al anterior). Por correo, primero confirma el email. */
  async function reenviar(c: CanalOtp) {
    if (!s.leadId) return;
    const email = valores.email.trim();
    if (c === 'email' && !RE_EMAIL.test(email)) {
      setEditandoEmail(true);
      return setMensaje(email ? 'Revisa tu correo: parece incompleto.' : mensajeError('EMAIL_REQUERIDO'));
    }
    setOcupado(true);
    const r = await api.reenviarOtp(s.leadId, c, c === 'email' ? email : undefined);
    setOcupado(false);
    if (r.tipo === 'ok') {
      const d = r.datos as { expira_en: string; reenvios_restantes: number; canal?: CanalOtp };
      const enviadoPor = d.canal ?? c;
      setEditandoEmail(false);
      setCodigo('');
      setMensaje(`Te enviamos un código nuevo por ${ETIQUETA_CANAL[enviadoPor]} a ${destinoOtp(enviadoPor, valores.telefono, email) ?? 'tu correo'}. El anterior ya no funciona.`);
      return enviar({ tipo: 'reenviado', expiraEn: d.expira_en, reenviosRestantes: d.reenvios_restantes, canal: enviadoPor });
    }
    if (r.tipo === 'error' && r.codigo === 'EMAIL_REQUERIDO') setEditandoEmail(true);
    if (r.tipo === 'fallback') return enviar({ tipo: 'fallback' });
    // La retención del horario venció (409 RETENCION_EXPIRADA): elegir otro horario; P5 reutiliza el lead.
    if (r.cuerpo.elegir_otro_horario) return elegirOtroHorario(mensajeError(r.codigo));
    setMensaje(mensajeError(r.codigo, r.cuerpo));
  }

  const err = (campo: string) =>
    errores[campo] ? <span className="field-error" id={`error-${campo.replace('respuestas.', '')}`}>{errores[campo]}</span> : null;
  const describe = (campo: string) => (errores[campo] ? `error-${campo.replace('respuestas.', '')}` : undefined);
  const setResp = (id: string, v: string) => setValores((x) => ({ ...x, respuestas: { ...x.respuestas, [id]: v } }));
  const linkFallback = linkWhatsApp(p.whatsapp.numero, textoFallback());
  const linkAgenda = linkAgendaWhatsApp(p.whatsapp.numero, { vacante: p.vacante, nombre: valores.nombre, eventId: eventoAgenda });
  const destino = destinoOtp(canal, valores.telefono, valores.email);
  const destinoEnviado = destinoOtp(s.canal, valores.telefono, valores.email);
  const campoEmailOtp = (id: string) => (
    <div className="form-group">
      <label htmlFor={id}>Correo para recibir el código</label>
      <input id={id} className="form-control" type="email" autoComplete="email" maxLength={254} placeholder="tu@correo.com"
        value={valores.email} aria-invalid={!!errores.email} aria-describedby={describe('email')}
        onChange={(e) => { setValores({ ...valores, email: e.target.value }); if (errores.email) setErrores(({ email: _e, ...resto }) => resto); }} />
      {err('email')}
    </div>
  );
  const indicePaso = { formulario: 0, horario: 1, whatsapp: 1, otp: 2, pase: 2, fallback: -1 }[s.paso];

  return (
    <div className="apply-wrapper" ref={raiz}>
      <ol className="form-steps-bar" aria-label="Pasos">
        {p.pasos.map((n, i) => (
          <li key={n} className={`step-pill${i === indicePaso ? ' is-active' : ''}`} aria-current={i === indicePaso ? 'step' : undefined}>
            <span className="step-num">{String(i + 1).padStart(2, '0')}</span> {n}
          </li>
        ))}
      </ol>

      <div className="flujo-mensaje" role="alert" aria-live="assertive">{mensaje && <p className="form-alert">{mensaje}</p>}</div>

      {s.paso === 'formulario' && (
        <form onSubmit={(e) => void validarDatos(e)} onFocus={iniciar} noValidate>
          <h3 className="section-divider-title" tabIndex={-1} data-foco>01 / Tus datos y preguntas del perfil</h3>
          <div className="form-grid">
            <div className="form-group">
              <label htmlFor="campo-nombre">Nombre completo *</label>
              <input id="campo-nombre" className="form-control" autoComplete="name" required maxLength={120} placeholder="Ej. Mariana Garza López"
                value={valores.nombre} aria-invalid={!!errores.nombre} aria-describedby={describe('nombre')} onChange={(e) => setValores({ ...valores, nombre: e.target.value })} />
              {err('nombre')}
            </div>
            <div className="form-group">
              <label htmlFor="campo-telefono">WhatsApp (10 dígitos) *</label>
              <input id="campo-telefono" className="form-control" type="tel" inputMode="numeric" autoComplete="tel-national" required maxLength={14} placeholder="Ej. 8112345678"
                value={valores.telefono} aria-invalid={!!errores.telefono} aria-describedby={describe('telefono')} onChange={(e) => setValores({ ...valores, telefono: e.target.value })} />
              {err('telefono')}
            </div>
            <div className="form-group">
              <label htmlFor="campo-email">Correo (opcional)</label>
              <input id="campo-email" className="form-control" type="email" autoComplete="email" maxLength={254} placeholder="tu@correo.com"
                value={valores.email} aria-invalid={!!errores.email} aria-describedby={describe('email')} onChange={(e) => setValores({ ...valores, email: e.target.value })} />
              {err('email')}
            </div>
            {p.preguntas.map((q) => {
              const campo = `respuestas.${q.id}`;
              const valor = valores.respuestas[q.id] ?? '';
              const req = q.requerida !== false;
              if (q.tipo === 'opcion' && q.presentacion === 'tarjetas') {
                return (
                  <fieldset key={q.id} className="form-group full-width" aria-describedby={describe(campo)}>
                    <legend>{q.etiqueta}{req ? ' *' : ''}</legend>
                    <div className="radio-cards">
                      {q.opciones.map((o, i) => (
                        <label key={o.valor} className="radio-card">
                          <input type="radio" name={q.id} id={i === 0 ? `campo-${q.id}` : undefined} value={o.valor} checked={valor === o.valor} required={req} onChange={() => setResp(q.id, o.valor)} />
                          <span>{o.etiqueta}</span>
                        </label>
                      ))}
                    </div>
                    {err(campo)}
                  </fieldset>
                );
              }
              return (
                <div key={q.id} className="form-group">
                  <label htmlFor={`campo-${q.id}`}>{q.etiqueta}{req ? ' *' : ''}</label>
                  {q.tipo === 'opcion' ? (
                    <select id={`campo-${q.id}`} className="form-control" required={req} value={valor} aria-invalid={!!errores[campo]} aria-describedby={describe(campo)} onChange={(e) => setResp(q.id, e.target.value)}>
                      <option value="" disabled>Selecciona…</option>
                      {q.opciones.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
                    </select>
                  ) : (
                    <input id={`campo-${q.id}`} className="form-control" type={q.tipo === 'numero' ? 'number' : 'text'} inputMode={q.tipo === 'numero' ? 'numeric' : undefined}
                      min={q.tipo === 'numero' ? q.min : undefined} max={q.tipo === 'numero' ? q.max : undefined} maxLength={q.tipo === 'texto' ? (q.max ?? 300) : undefined}
                      placeholder={q.placeholder} required={req} value={valor} aria-invalid={!!errores[campo]} aria-describedby={describe(campo)} onChange={(e) => setResp(q.id, e.target.value)} />
                  )}
                  {err(campo)}
                </div>
              );
            })}
          </div>
          <label className="consent-check">
            <input type="checkbox" id="campo-consentimiento" checked={consentido} onChange={(e) => setConsentido(e.target.checked)} aria-invalid={!!errores.consentimiento} aria-describedby={describe('consentimiento')} required />
            <span>He leído y acepto el <a href="/aviso-de-privacidad/" target="_blank" rel="noopener">Aviso de Privacidad</a> (versión {configPublica.versionAviso}) y autorizo que me contacten por WhatsApp para mi entrevista.</span>
          </label>
          {err('consentimiento')}
          <button type="submit" className="btn btn-primary btn-block" disabled={ocupado} aria-busy={ocupado}>Continuar: elegir día y hora <span aria-hidden="true">→</span></button>
        </form>
      )}

      {s.paso === 'horario' && (
        <div>
          <h3 className="section-divider-title" tabIndex={-1} data-foco>02 / Selecciona día y hora de entrevista</h3>
          {s.aviso && <p className="form-alert">{s.aviso}</p>}
          {dias === null && <p aria-live="polite">Cargando horarios disponibles…</p>}
          {dias && dias.length === 0 && (
            <p className="form-alert">Por ahora no hay horarios disponibles. <a href={linkFallback} target="_blank" rel="noopener noreferrer">Escríbenos por WhatsApp</a> y te agendamos.</p>
          )}
          {dias && dias.length > 0 && (
            <>
              <div className="form-group">
                <span className="group-label" id="lbl-dia">Día disponible para tu entrevista:</span>
                <div className="slots-grid" role="group" aria-labelledby="lbl-dia">
                  {dias.map((d) => (
                    <button key={d.fecha} type="button" className={`slot-btn${dia === d.fecha ? ' selected' : ''}`} aria-pressed={dia === d.fecha} onClick={() => { setDia(d.fecha); setSlot(null); }}>{d.etiqueta}</button>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <span className="group-label" id="lbl-hora">Horario de entrevista:</span>
                <div className="slots-grid" role="group" aria-labelledby="lbl-hora">
                  {dias.find((d) => d.fecha === dia)?.horas.map((h) => (
                    <button key={h.inicio} type="button" className={`slot-btn${slot === h.inicio ? ' selected' : ''}`} aria-pressed={slot === h.inicio} onClick={() => setSlot(h.inicio)}>{h.etiqueta}</button>
                  ))}
                </div>
              </div>
              <fieldset className="form-group canal-otp">
                <legend>¿Por dónde quieres recibir tu código de verificación?</legend>
                <div className="radio-cards canal-otp-opciones">
                  {CANALES_OTP.map((c) => (
                    <label key={c} className="radio-card">
                      <input type="radio" name="canal_otp" value={c} checked={canal === c} onChange={() => { setCanal(c); setMensaje(null); }} />
                      <span>{TITULO_CANAL[c]}</span>
                    </label>
                  ))}
                </div>
                {canal === 'email' && campoEmailOtp('campo-email-otp')}
                <p className="otp-destino" aria-live="polite">
                  {destino ? <>Enviaremos el código a <strong>{destino}</strong></> : 'Escribe el correo al que enviaremos el código.'}
                </p>
              </fieldset>
              <Turnstile onToken={setToken} onError={() => enviar({ tipo: 'fallback' })} reinicio={reinicioTurnstile} />
              <button type="button" className="btn btn-primary btn-block" disabled={ocupado || !slot} onClick={() => void postular()}>
                {ocupado ? 'Enviando…' : <>Enviar código por {ETIQUETA_CANAL[canal]} <span aria-hidden="true">→</span></>}
              </button>
            </>
          )}
          <button type="button" className="btn btn-link" onClick={() => enviar({ tipo: 'volver' })}>← Cambiar mis datos</button>
        </div>
      )}

      {s.paso === 'whatsapp' && (
        <div className="fallback-box agenda-whatsapp">
          <h3 className="section-divider-title" tabIndex={-1} data-foco>02 / Agenda tu entrevista por WhatsApp</h3>
          <p>Para esta vacante, el equipo de reclutamiento agenda las entrevistas directamente por WhatsApp. Envía el mensaje y te proponemos día y hora.</p>
          <a className="btn btn-lime btn-block" href={linkAgenda} target="_blank" rel="noopener noreferrer"
            onClick={() => track('ClickCTA', { location: 'agenda_whatsapp', agenda_modo: 'whatsapp' }, eventoAgenda)}>
            Agendar mi entrevista por WhatsApp ({p.whatsapp.etiqueta}) <span aria-hidden="true">↗</span>
          </a>
          <button type="button" className="btn btn-link" onClick={() => enviar({ tipo: 'volver' })}>← Cambiar mis datos</button>
        </div>
      )}

      {s.paso === 'otp' && (
        <form onSubmit={verificar} noValidate>
          <h3 className="section-divider-title" tabIndex={-1} data-foco>03 / Verifica tu contacto</h3>
          <p className="otp-destino otp-destino-enviado">
            Código enviado por <strong>{ETIQUETA_CANAL[s.canal]}</strong> a <strong>{destinoEnviado ?? 'tu correo'}</strong>
          </p>
          <p className="otp-intro">
            Escribe el código de 6 dígitos que te enviamos. Tu horario <strong>{horarioElegido()}</strong> queda apartado mientras lo verificas
            {s.expiraEn ? <> (el código vence a las {new Date(s.expiraEn).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit', timeZone: p.zonaHoraria })})</> : null}.
          </p>
          <div className="form-group">
            <label htmlFor="campo-otp">Código de verificación</label>
            <input id="campo-otp" className="form-control otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
              value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={ocupado || codigo.length !== 6}>{ocupado ? 'Verificando…' : 'Verificar y generar mi pase'}</button>
          <div className="otp-canales">
            <p className="group-label">
              ¿No te llega? Pide un código nuevo por otro medio {s.reenviosRestantes > 0 ? `(${s.reenviosRestantes} ${s.reenviosRestantes === 1 ? 'envío disponible' : 'envíos disponibles'})` : '(límite alcanzado)'}:
            </p>
            {CANALES_OTP.map((c) => (
              <button key={c} type="button" className="btn btn-link otp-canal" disabled={ocupado || s.reenviosRestantes <= 0}
                onClick={() => (c === 'email' && !editandoEmail ? setEditandoEmail(true) : void reenviar(c))}>
                {c === s.canal ? 'Reenviar' : 'Enviar'} por {ETIQUETA_CANAL[c]}
                {c !== 'email' ? ` a ${destinoOtp(c, valores.telefono, '')}` : valores.email.trim() ? ` a ${valores.email.trim().toLowerCase()}` : ''}
              </button>
            ))}
            {editandoEmail && (
              <div className="otp-email">
                {campoEmailOtp('campo-email-reenvio')}
                <button type="button" className="btn btn-navy btn-sm" disabled={ocupado || s.reenviosRestantes <= 0} onClick={() => void reenviar('email')}>
                  Enviar código a este correo
                </button>
              </div>
            )}
          </div>
          <p className="otp-ayuda">
            ¿El número o correo está mal? <button type="button" className="btn-link btn-link-inline" onClick={() => enviar({ tipo: 'volver' })}>Corrige tus datos</button>
            {' '}· <a href={linkFallback} target="_blank" rel="noopener noreferrer">Escríbenos por WhatsApp</a>.
          </p>
        </form>
      )}

      {s.paso === 'pase' && (
        <div className="pass-result-box visible">
          <div className="pass-header">
            <div className="pass-brand">
              <img src={IMG.logo.src} alt="Capital Humano 369" width={110} height={52} />
              <div>
                <span className="pass-kicker">✓ {VERIFICADO[s.canal]} VERIFICADO · PASE OFICIAL</span>
                <h3 tabIndex={-1} data-foco>PASE DE ENTREVISTA</h3>
              </div>
            </div>
            <div className="pass-folio"><span>Folio</span><strong>{s.folio}</strong></div>
          </div>
          <div className="pass-body">
            <div>
              <div className="pass-field"><strong>Candidato(a):</strong> <span>{valores.nombre}</span></div>
              <div className="pass-field"><strong>Vacante:</strong> {p.pase.vacante}</div>
              {p.preguntas.filter((q) => q.id === 'municipio' || q.id === 'turno').map((q) => valores.respuestas[q.id] && (
                <div key={q.id} className="pass-field"><strong>{q.id === 'turno' ? 'Turno Solicitado' : 'Municipio'}:</strong> <span>{valores.respuestas[q.id]}</span></div>
              ))}
              <div className="pass-field"><strong>Cita Programada:</strong> <span className="pass-cita">{s.citaInicio ? formatearCita(s.citaInicio, p.zonaHoraria) : '-'}</span></div>
              <div className="pass-field"><strong>Atención en Recepción:</strong> <span className="pass-atencion">{p.pase.atencion}</span></div>
              <div className="pass-field"><strong>Dirección:</strong> {p.pase.direccion}</div>
            </div>
            <div className="pass-docs">
              <strong>Presentar COPIAS de tu documentación:</strong>
              <ul>{p.pase.documentos.map((d) => <li key={d}>{d}</li>)}</ul>
              <div className="pass-wa">WhatsApp: {p.whatsapp.etiqueta}</div>
            </div>
          </div>
          <div className="pass-actions">
            <a className="btn btn-lime" href={linkWhatsApp(p.whatsapp.numero, `Hola ${p.whatsapp.atencion}, tengo mi pase de entrevista con folio ${s.folio}.`)} target="_blank" rel="noopener noreferrer">
              Escribir a reclutamiento ({p.whatsapp.etiqueta}) <span aria-hidden="true">↗</span>
            </a>
            <button type="button" className="btn btn-navy" onClick={() => window.print()}>Imprimir / Guardar Pase</button>
          </div>
        </div>
      )}

      {s.paso === 'fallback' && (
        <div className="fallback-box">
          <h3 tabIndex={-1} data-foco>No pudimos completar tu registro en línea</h3>
          <p>No te preocupes: tus datos siguen aquí. Envíanos tu postulación por WhatsApp y te agendamos directamente.</p>
          <a className="btn btn-lime btn-block" href={linkFallback} target="_blank" rel="noopener noreferrer">Enviar mi postulación por WhatsApp ({p.whatsapp.etiqueta}) <span aria-hidden="true">↗</span></a>
          <button type="button" className="btn btn-link" onClick={() => enviar({ tipo: 'volver' })}>Intentar de nuevo</button>
        </div>
      )}
    </div>
  );
}
