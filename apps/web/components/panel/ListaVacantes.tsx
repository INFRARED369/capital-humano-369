'use client';
/** Vacantes visibles según el rol (DSH-06, E2E-11): el RLS decide qué filas llegan. */
import { puedeEditarReglas } from '../../lib/panel/roles';
import { rutaVacante } from '../../lib/panel/rutas';
import { EstadoCarga, useDatos } from './comunes';
import { usePanel } from './PanelShell';

export function ListaVacantes() {
  const { api, perfil } = usePanel();
  const carga = useDatos(() => api.vacantes(), [api]);
  return (
    <EstadoCarga carga={carga}>
      {({ vacantes, clientes }) =>
        vacantes.length === 0 ? (
          <p>No tienes vacantes asignadas.</p>
        ) : (
          <div className="p-scroll" tabIndex={0} role="region" aria-label="Lista de vacantes (desplazable)">
            <table className="p-tabla">
              <caption>{vacantes.length === 1 ? '1 vacante' : `${vacantes.length} vacantes`}</caption>
              <thead>
                <tr>
                  <th scope="col">Vacante</th>
                  <th scope="col">Código</th>
                  <th scope="col">Cliente</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {vacantes.map((v) => (
                  <tr key={v.id}>
                    <td>{v.nombre}<br /><span className="p-ayuda">/vacantes/{v.slug}/</span></td>
                    <td>{v.codigo}</td>
                    <td>{clientes.find((c) => c.id === v.cliente_id)?.nombre ?? '—'}</td>
                    <td>{v.activa ? 'Activa' : 'Inactiva'}{v.agenda_modo === 'whatsapp' ? ' · agenda por WhatsApp' : ''}</td>
                    <td>
                      <a href={rutaVacante(v.id)}>{puedeEditarReglas(perfil, v.id) ? 'Editar reglas' : 'Ver reglas'}<span className="panel-saltar"> de {v.nombre}</span></a>
                      {' · '}
                      <a href={`/panel/agenda/?vacante=${v.id}`}>Agenda<span className="panel-saltar"> de {v.nombre}</span></a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </EstadoCarga>
  );
}
