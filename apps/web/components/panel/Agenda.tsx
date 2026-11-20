'use client';
/** Agenda del día (DSH-05): citas de las vacantes visibles, con folio y nombre de pila (sin teléfono). */
import { useEffect, useState } from 'react';
import { systemClock } from '../../../../src/shared/clock';
import { combinarAgenda, hoyLocal } from '../../lib/panel/agenda';
import { esUuid, leerParam, rutaCita } from '../../lib/panel/rutas';
import { EstadoCarga, useDatos, useUbicacion } from './comunes';
import { usePanel } from './PanelShell';

const ZONA = 'America/Mexico_City';

export function Agenda() {
  const { api } = usePanel();
  const loc = useUbicacion();
  const [fecha, setFecha] = useState(() => hoyLocal(systemClock, ZONA));
  const [vacante, setVacante] = useState('');
  useEffect(() => {
    if (!loc) return;
    const v = leerParam(loc.search, 'vacante');
    const f = leerParam(loc.search, 'fecha');
    if (esUuid(v)) setVacante(v);
    if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) setFecha(f);
  }, [loc]);

  const vacantes = useDatos(() => api.vacantes(), [api]);
  const agenda = useDatos(() => api.agenda(fecha, vacante || undefined), [api, fecha, vacante]);
  const nombres = vacantes.estado === 'ok' ? new Map(vacantes.datos.vacantes.map((v) => [v.id, v.nombre])) : new Map<string, string>();

  return (
    <>
      <form className="p-rejilla" onSubmit={(e) => e.preventDefault()} aria-label="Filtros de la agenda">
        <div className="p-campo">
          <label htmlFor="a-fecha">Día</label>
          <input id="a-fecha" type="date" value={fecha} onChange={(e) => e.target.value && setFecha(e.target.value)} />
        </div>
        <div className="p-campo">
          <label htmlFor="a-vacante">Vacante</label>
          <select id="a-vacante" value={vacante} onChange={(e) => setVacante(e.target.value)}>
            <option value="">Todas mis vacantes</option>
            {vacantes.estado === 'ok' && vacantes.datos.vacantes.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        </div>
      </form>
      <EstadoCarga carga={agenda}>
        {({ citas, leads }) => {
          const items = combinarAgenda(citas, leads, ZONA);
          return items.length === 0 ? (
            <p role="status">No hay citas para este día.</p>
          ) : (
            <div className="p-scroll" tabIndex={0} role="region" aria-label="Citas del día (desplazable)">
              <table className="p-tabla">
                <caption>{items.length} cita(s) · hora de Ciudad de México</caption>
                <thead>
                  <tr><th scope="col">Hora</th><th scope="col">Folio</th><th scope="col">Candidato</th><th scope="col">Vacante</th><th scope="col">Estado</th><th scope="col">Acción</th></tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id}>
                      <td>{c.hora}</td>
                      <td>{c.folio}</td>
                      <td>{c.nombrePila}</td>
                      <td>{nombres.get(c.vacante_id) ?? '—'}</td>
                      <td><span className="p-estado">{c.etiquetaEstado}</span></td>
                      <td><a href={rutaCita(c.id)}>Ver cita<span className="panel-saltar"> {c.folio} de las {c.hora}</span></a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </EstadoCarga>
    </>
  );
}
