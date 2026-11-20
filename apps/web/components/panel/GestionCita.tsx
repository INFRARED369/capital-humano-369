'use client';
/**
 * Página pública para que el candidato cancele o reprograme su cita con el link firmado de WhatsApp
 * (CIT-11, C15, E2E-10). Lee `?t=<token>` y habla solo con la edge function gestionar-cita.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { configPublica } from '../../lib/config';
import { agruparSlots, crearClienteGestion, formatearCita, interpretarConsulta, mensajeGestion, quitarDeUrl, tomarToken, type Consulta } from '../../lib/panel/gestion';

type Estado =
  | { fase: 'cargando' }
  | { fase: 'error'; codigo: string }
  | { fase: 'listo'; token: string; consulta: Consulta; error?: string }
  | { fase: 'hecho'; accion: 'cancelar' | 'reprogramar'; inicio?: string; zona: string };

export function GestionCita() {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const [enviando, setEnviando] = useState(false);
  const cliente = useMemo(() => crearClienteGestion(configPublica.funcionesUrl), []);

  useEffect(() => {
    // Este efecto (hijo) corre antes que el de TrackingProvider: la URL ya no lleva el token cuando carga el tracking.
    const token = tomarToken(window);
    // El router de Next reescribe la URL en su propio efecto (padre); se vuelve a limpiar cuando termina.
    const t = window.setTimeout(() => quitarDeUrl(window), 0);
    if (!token) setEstado({ fase: 'error', codigo: 'SIN_TOKEN' });
    else
      void cliente.consultar(token).then((r) => {
        if (r.tipo === 'error') return setEstado({ fase: 'error', codigo: r.codigo });
        const consulta = interpretarConsulta(r.cuerpo);
        setEstado(consulta ? { fase: 'listo', token, consulta } : { fase: 'error', codigo: 'DESCONOCIDO' });
      });
    return () => window.clearTimeout(t);
  }, [cliente]);

  async function ejecutar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (estado.fase !== 'listo') return;
    const { token, consulta } = estado;
    const nuevo = consulta.accion === 'reprogramar' ? String(new FormData(e.currentTarget).get('horario') ?? '') : undefined;
    if (consulta.accion === 'reprogramar' && !nuevo) return setEstado({ ...estado, error: 'Elige un horario.' });
    setEnviando(true);
    const r = await cliente.ejecutar(token, nuevo);
    setEnviando(false);
    if (r.tipo === 'ok') return setEstado({ fase: 'hecho', accion: consulta.accion, inicio: nuevo, zona: consulta.cita.zona_horaria });
    if (r.status === 401) return setEstado({ fase: 'error', codigo: r.codigo });
    setEstado({ ...estado, error: mensajeGestion(r.codigo).mensaje });
  }

  return (
    <div className="gestion">
      <header className="gestion-cabecera">369 Capital Humano</header>
      <main className="gestion-main" id="contenido">
        {estado.fase === 'cargando' && (<><h1>Tu cita</h1><p role="status">Cargando tu cita…</p></>)}
        {estado.fase === 'error' && (
          <>
            <h1>{mensajeGestion(estado.codigo).titulo}</h1>
            <p role="alert">{mensajeGestion(estado.codigo).mensaje}</p>
            <p><a href={`https://wa.me/${configPublica.whatsappFallback}`}>Escríbenos por WhatsApp</a></p>
          </>
        )}
        {estado.fase === 'hecho' && (
          <>
            <h1>{estado.accion === 'cancelar' ? 'Tu cita fue cancelada' : 'Tu cita fue reprogramada'}</h1>
            <p role="status">
              {estado.accion === 'cancelar'
                ? 'Liberamos tu horario. Si quieres agendar otra vez, vuelve a la página de la vacante.'
                : `Nuevo horario: ${formatearCita(estado.inicio!, estado.zona)}. Te enviaremos la confirmación por WhatsApp.`}
            </p>
          </>
        )}
        {estado.fase === 'listo' && (
          <>
            <h1>
              {estado.consulta.cita.estado !== 'confirmada'
                ? mensajeGestion('TRANSICION_INVALIDA').titulo
                : estado.consulta.accion === 'cancelar' ? 'Cancelar tu cita' : 'Reprogramar tu cita'}
            </h1>
            <p>Tu cita: <strong>{formatearCita(estado.consulta.cita.inicio_utc, estado.consulta.cita.zona_horaria)}</strong> (hora del centro de México).</p>
            {estado.consulta.cita.estado !== 'confirmada' ? (
              <p role="alert">{mensajeGestion('TRANSICION_INVALIDA').mensaje}</p>
            ) : (
              <form onSubmit={ejecutar} noValidate>
                {estado.consulta.accion === 'reprogramar' &&
                  (estado.consulta.slots.length === 0 ? (
                    <p>No hay otros horarios disponibles por ahora. Escríbenos por WhatsApp.</p>
                  ) : (
                    agruparSlots(estado.consulta.slots).map((d) => (
                      <fieldset key={d.fecha} style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
                        <legend><strong>{d.etiqueta}</strong></legend>
                        <div className="gestion-horarios">
                          {d.slots.map((s) => (
                            <label key={s.inicio_utc}><input type="radio" name="horario" value={s.inicio_utc} required />{s.hora_local}</label>
                          ))}
                        </div>
                      </fieldset>
                    ))
                  ))}
                <button className="p-boton" type="submit" disabled={enviando || (estado.consulta.accion === 'reprogramar' && estado.consulta.slots.length === 0)}>
                  {enviando ? 'Enviando…' : estado.consulta.accion === 'cancelar' ? 'Sí, cancelar mi cita' : 'Confirmar nuevo horario'}
                </button>
                <div aria-live="polite">{estado.error && <p className="p-error">{estado.error}</p>}</div>
              </form>
            )}
          </>
        )}
      </main>
    </div>
  );
}
