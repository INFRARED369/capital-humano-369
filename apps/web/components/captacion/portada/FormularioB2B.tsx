'use client';
import { useState, type FormEvent } from 'react';
import { SERVICIOS_B2B } from '../../../../../src/domains/captacion/ui/servicios-b2b';
import { crearClienteCaptacion } from '../../../lib/captacion/api';
import { mensajeError } from '../../../lib/captacion/flujo';
import { linkWhatsApp } from '../../../lib/captacion/whatsapp';
import { configPublica } from '../../../lib/config';
import { track } from '../../../lib/tracking';
import { Turnstile } from '../Turnstile';

const WHATSAPP_COMERCIAL = '528134700891';
type Estado = { tipo: 'inicial' } | { tipo: 'enviando' } | { tipo: 'enviado' } | { tipo: 'error'; mensaje: string } | { tipo: 'fallback' };

/** Formulario B2B #lead-form (CAP-09) → edge function contacto-b2b, con consentimiento y anti-bot. */
export function FormularioB2B() {
  const [estado, setEstado] = useState<Estado>({ tipo: 'inicial' });
  const [token, setToken] = useState('');
  const [reinicio, setReinicio] = useState(0);
  const [iniciado, setIniciado] = useState(false);

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    if (!d.get('consentimiento')) return setEstado({ tipo: 'error', mensaje: mensajeError('CONSENTIMIENTO_REQUERIDO') });
    if (!token) return setEstado({ tipo: 'error', mensaje: mensajeError('ANTIBOT_REQUERIDO') });
    setEstado({ tipo: 'enviando' });
    const mensaje = String(d.get('message') ?? '').trim();
    const r = await crearClienteCaptacion(configPublica.funcionesUrl).enviarContactoB2B({
      nombre: String(d.get('name') ?? ''), empresa: String(d.get('company') ?? ''), email: String(d.get('email') ?? ''),
      servicio: String(d.get('service') ?? ''), ...(mensaje ? { mensaje } : {}),
      consentimiento: { aceptado: true, version: configPublica.versionAviso }, turnstile_token: token,
    });
    setToken('');
    setReinicio((n) => n + 1);
    if (r.tipo === 'ok') {
      track('FormSubmitted', { form_id: 'lead-form' });
      form.reset();
      setEstado({ tipo: 'enviado' });
    } else if (r.tipo === 'fallback') setEstado({ tipo: 'fallback' });
    else setEstado({ tipo: 'error', mensaje: mensajeError(r.codigo, r.cuerpo) });
  }

  const ocupado = estado.tipo === 'enviando';
  return (
    <form className="contact-form reveal reveal-delay" id="lead-form" onSubmit={enviar} noValidate={false}
      onFocus={() => { if (!iniciado) { setIniciado(true); track('FormStarted', { form_id: 'lead-form' }); } }}>
      <div className="form-row">
        <label>Nombre <input type="text" name="name" placeholder="Tu nombre" required minLength={2} maxLength={120} autoComplete="name" /></label>
        <label>Empresa <input type="text" name="company" placeholder="Nombre de tu empresa" required maxLength={160} autoComplete="organization" /></label>
      </div>
      <label>Correo corporativo <input type="email" name="email" placeholder="tu@empresa.com" required maxLength={254} autoComplete="email" /></label>
      <label>¿Qué necesitas?
        <select name="service" required defaultValue="">
          <option value="" disabled>Selecciona una solución</option>
          {SERVICIOS_B2B.map((s) => <option key={s}>{s}</option>)}
        </select>
      </label>
      <label>Cuéntanos un poco más <textarea name="message" rows={4} maxLength={2000} placeholder="Puestos, volumen, ubicación o reto principal"></textarea></label>
      <label className="consent-check">
        <input type="checkbox" name="consentimiento" required />
        <span>Acepto el <a href="/aviso-de-privacidad/" target="_blank" rel="noopener">Aviso de Privacidad</a> (versión {configPublica.versionAviso}) para dar seguimiento a esta solicitud.</span>
      </label>
      {/* Anti-bot diferido: el widget (script + iframe de Cloudflare) se carga al empezar a llenar el formulario (NFR-RND-01). */}
      {iniciado && <Turnstile onToken={setToken} onError={() => setEstado({ tipo: 'fallback' })} reinicio={reinicio} />}
      <button className="button button-dark" type="submit" disabled={ocupado}>
        {ocupado ? 'Enviando…' : estado.tipo === 'enviado' ? <>Enviado <span aria-hidden="true">✓</span></> : <>Solicitar diagnóstico <span aria-hidden="true">↗</span></>}
      </button>
      <div className="form-feedback" role="status" aria-live="polite">
        {estado.tipo === 'enviado' && <div className="form-success visible"><span aria-hidden="true">✓</span> Recibimos tu mensaje. Pronto nos pondremos en contacto.</div>}
        {estado.tipo === 'error' && <p className="form-error">{estado.mensaje}</p>}
        {estado.tipo === 'fallback' && (
          <p className="form-error">
            No pudimos enviar tu solicitud en este momento. Escríbenos por{' '}
            <a href={linkWhatsApp(WHATSAPP_COMERCIAL, 'Hola Capital Humano 369, me interesa un diagnóstico para mi empresa.')} target="_blank" rel="noopener noreferrer">WhatsApp</a> o a{' '}
            <a href="mailto:hola@369capitalhumano.com">hola@369capitalhumano.com</a>.
          </p>
        )}
      </div>
    </form>
  );
}
