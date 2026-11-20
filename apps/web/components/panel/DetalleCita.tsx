'use client';
/**
 * Detalle de cita (link desde el evento de Zoho, CIT-10) y registro de asistencia + evaluación (DSH-05).
 * citas.registrar_asistencia publica AsistenciaRegistrada → evento offline a CAPI (T6) y agradecimiento (E2E-09).
 */
import { useState, type FormEvent } from 'react';
import { combinarAgenda, evaluacionDesdeFormulario, formatearFecha, mensajeErrorAsistencia, puedeRegistrarAsistencia, RECOMENDACIONES } from '../../lib/panel/agenda';
import { puedeOperar } from '../../lib/panel/roles';
import { leerIdCita } from '../../lib/panel/rutas';
import { EstadoCarga, useDatos, useUbicacion } from './comunes';
import { usePanel } from './PanelShell';

const ZONA = 'America/Mexico_City';

export function DetalleCita() {
  const { api, perfil } = usePanel();
  const loc = useUbicacion();
  const id = loc ? leerIdCita(loc) : null;
  const carga = useDatos(async () => (id ? { ...(await api.cita(id)), contratacion: await api.contratacion(id) } : null), [api, id]);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (!loc) return <p className="p-cargando" role="status">Cargando…</p>;
  if (!id) return <p className="p-error" role="alert">El enlace no incluye una cita válida. Usa el enlace del evento de Zoho o la <a href="/panel/agenda/">agenda</a>.</p>;

  return (
    <EstadoCarga carga={carga}>
      {(d) => {
        if (!d?.cita) return <p role="alert">La cita no existe o no tienes acceso.</p>;
        const [c] = combinarAgenda([d.cita], d.leads, ZONA);
        const item = c!;
        const operable = puedeOperar(perfil, item.vacante_id) && puedeRegistrarAsistencia(item.estado);
        const ev = (item.evaluacion ?? {}) as { calificacion?: number; recomendacion?: string; notas?: string };

        async function registrar(e: FormEvent<HTMLFormElement>) {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const asistio = f.get('asistio');
          if (asistio !== 'si' && asistio !== 'no') return setAviso({ tipo: 'error', texto: 'Indica si la persona asistió.' });
          const evaluacion = evaluacionDesdeFormulario({ calificacion: String(f.get('calificacion') ?? ''), recomendacion: String(f.get('recomendacion') ?? ''), notas: String(f.get('notas') ?? '') });
          if (evaluacion.ok === false) return setAviso({ tipo: 'error', texto: evaluacion.error });
          setEnviando(true);
          try {
            await api.registrarAsistencia(item.id, asistio === 'si', evaluacion.value);
            setAviso({ tipo: 'ok', texto: asistio === 'si' ? 'Asistencia registrada. Se enviará el agradecimiento al candidato.' : 'Registrado como no asistió.' });
            carga.recargar();
          } catch (err) {
            setAviso({ tipo: 'error', texto: mensajeErrorAsistencia(err instanceof Error ? err.message : '') });
          } finally {
            setEnviando(false);
          }
        }

        return (
          <>
            <dl className="p-tarjeta p-rejilla">
              <div><dt>Folio</dt><dd>{item.folio}</dd></div>
              <div><dt>Candidato</dt><dd>{item.nombrePila}</dd></div>
              <div><dt>Horario</dt><dd>{formatearFecha(item.inicio, ZONA)} · {item.hora}</dd></div>
              <div><dt>Estado</dt><dd><span className="p-estado">{item.etiquetaEstado}</span></dd></div>
            </dl>
            {!puedeOperar(perfil, item.vacante_id) ? (
              <p>Tu rol es de solo lectura para esta vacante.</p>
            ) : !puedeRegistrarAsistencia(item.estado) ? (
              <p>Esta cita no admite registro de asistencia ({item.etiquetaEstado.toLowerCase()}).</p>
            ) : (
              <form className="p-tarjeta" onSubmit={registrar} noValidate aria-labelledby="t-asistencia">
                <h2 id="t-asistencia">Asistencia y evaluación</h2>
                <fieldset className="p-grupo" disabled={!operable || enviando}>
                  <legend>¿Asistió?</legend>
                  <div className="p-checks">
                    <label><input type="radio" name="asistio" value="si" defaultChecked={item.estado === 'asistio'} disabled={item.estado === 'no_asistio'} />Sí asistió</label>
                    <label><input type="radio" name="asistio" value="no" defaultChecked={item.estado === 'no_asistio'} disabled={item.estado === 'asistio'} />No asistió</label>
                  </div>
                </fieldset>
                <div className="p-rejilla">
                  <div className="p-campo">
                    <label htmlFor="e-cal">Calificación</label>
                    <select id="e-cal" name="calificacion" defaultValue={ev.calificacion ? String(ev.calificacion) : ''}>
                      <option value="">Sin calificar</option>
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div className="p-campo">
                    <label htmlFor="e-rec">Recomendación</label>
                    <select id="e-rec" name="recomendacion" defaultValue={ev.recomendacion ?? ''}>
                      <option value="">Sin recomendación</option>
                      {RECOMENDACIONES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div className="p-campo">
                  <label htmlFor="e-notas">Notas</label>
                  <textarea id="e-notas" name="notas" rows={4} maxLength={1000} defaultValue={ev.notas ?? ''} aria-describedby="e-notas-ayuda" />
                  <p id="e-notas-ayuda" className="p-ayuda">No escribas teléfonos, correos ni datos sensibles. Se borran con la política de retención.</p>
                </div>
                <button className="p-boton" type="submit" disabled={!operable || enviando}>{enviando ? 'Guardando…' : 'Registrar'}</button>
                <div aria-live="polite">{aviso && <p className={aviso.tipo === 'ok' ? 'p-ok' : 'p-error'}>{aviso.texto}</p>}</div>
              </form>
            )}
            {item.estado === 'asistio' && (
              <Contratacion citaId={item.id} operable={puedeOperar(perfil, item.vacante_id)} estado={d.contratacion} alCambiar={carga.recargar} />
            )}
            <p><a href="/panel/agenda/">Volver a la agenda</a></p>
          </>
        );
      }}
    </EstadoCarga>
  );
}

/** Contratado → expediente entregado al cliente (LeadContratado). Solo para quien asistió. */
function Contratacion({ citaId, operable, estado, alCambiar }: { citaId: string; operable: boolean; estado: { contratado_en: string; entregado_en: string | null } | null; alCambiar: () => void }) {
  const { api } = usePanel();
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const fecha = (iso: string) => new Date(iso).toLocaleString('es-MX', { timeZone: ZONA, dateStyle: 'medium', timeStyle: 'short' });

  async function marcar(entregado: boolean) {
    setEnviando(true);
    try {
      await api.registrarContratacion(citaId, entregado);
      setAviso({ tipo: 'ok', texto: entregado ? 'Expediente marcado como entregado al cliente.' : 'Candidato marcado como contratado.' });
      alCambiar();
    } catch (err) {
      setAviso({ tipo: 'error', texto: mensajeErrorAsistencia(err instanceof Error ? err.message : '') });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="p-tarjeta" aria-labelledby="t-contratacion">
      <h2 id="t-contratacion">Contratación</h2>
      <p>
        {!estado ? 'Aún no se registra la contratación.' : estado.entregado_en ? `Contratado el ${fecha(estado.contratado_en)} · expediente entregado el ${fecha(estado.entregado_en)}.` : `Contratado el ${fecha(estado.contratado_en)} · expediente pendiente de entregar.`}
      </p>
      {operable && !estado?.entregado_en && (
        <div className="p-acciones">
          {!estado && <button type="button" className="p-boton" disabled={enviando} onClick={() => marcar(false)}>Marcar como contratado</button>}
          <button type="button" className={estado ? 'p-boton' : 'p-boton secundario'} disabled={enviando} onClick={() => marcar(true)}>Expediente entregado al cliente</button>
        </div>
      )}
      <p className="p-ayuda">Al entregar el expediente, los datos del candidato se conservan solo el plazo de la política de retención.</p>
      <div aria-live="polite">{aviso && <p className={aviso.tipo === 'ok' ? 'p-ok' : 'p-error'}>{aviso.texto}</p>}</div>
    </section>
  );
}
