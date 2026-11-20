'use client';
/**
 * Dashboard (DSH-01..03): KPIs, funnel por dimensión y leads por día. Gráficas simples y accesibles:
 * tablas con barras decorativas (aria-hidden) y el número siempre en texto.
 */
import { useState } from 'react';
import { cargarDashboard, escalaBarras, formatoMxn, formatoNumero, formatoPct, type Dimension } from '../../../../src/domains/dashboard';
import { systemClock } from '../../../../src/shared/clock';
import { hoyLocal } from '../../lib/panel/agenda';
import { EstadoCarga, useDatos } from './comunes';
import { usePanel } from './PanelShell';

const sumarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DIMENSIONES: Array<[Dimension, string]> = [['campana', 'Campaña'], ['origen', 'Origen'], ['vacante', 'Vacante'], ['cliente', 'Cliente']];

export function Dashboard() {
  const { api } = usePanel();
  const hoy = hoyLocal(systemClock, 'America/Mexico_City');
  const [filtro, setFiltro] = useState({ desde: sumarDias(hoy, -29), hasta: hoy, vacanteId: '', dimension: 'campana' as Dimension });
  const vacantes = useDatos(() => api.vacantes(), [api]);
  const nombre = (id: string) => (vacantes.estado === 'ok' ? vacantes.datos.vacantes.find((v) => v.id === id)?.nombre ?? vacantes.datos.clientes.find((c) => c.id === id)?.nombre : undefined) ?? id;
  const carga = useDatos(
    () => cargarDashboard(api.fuenteDashboard(), { desde: filtro.desde, hasta: filtro.hasta, dimension: filtro.dimension, ...(filtro.vacanteId ? { vacanteId: filtro.vacanteId } : {}) }),
    [api, filtro],
  );

  return (
    <>
      <form className="p-rejilla" onSubmit={(e) => e.preventDefault()} aria-label="Filtros del dashboard">
        <div className="p-campo"><label htmlFor="d-desde">Desde</label><input id="d-desde" type="date" value={filtro.desde} max={filtro.hasta} onChange={(e) => e.target.value && setFiltro({ ...filtro, desde: e.target.value })} /></div>
        <div className="p-campo"><label htmlFor="d-hasta">Hasta</label><input id="d-hasta" type="date" value={filtro.hasta} min={filtro.desde} onChange={(e) => e.target.value && setFiltro({ ...filtro, hasta: e.target.value })} /></div>
        <div className="p-campo">
          <label htmlFor="d-vacante">Vacante</label>
          <select id="d-vacante" value={filtro.vacanteId} onChange={(e) => setFiltro({ ...filtro, vacanteId: e.target.value })}>
            <option value="">Todas</option>
            {vacantes.estado === 'ok' && vacantes.datos.vacantes.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        </div>
        <div className="p-campo">
          <label htmlFor="d-dim">Funnel por</label>
          <select id="d-dim" value={filtro.dimension} onChange={(e) => setFiltro({ ...filtro, dimension: e.target.value as Dimension })}>
            {DIMENSIONES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>
      </form>

      <EstadoCarga carga={carga}>
        {(d) => {
          const k = d.kpis;
          const escalaSerie = escalaBarras(d.serieLeads.map((s) => s.valor));
          return (
            <>
              <p className="p-ayuda">{d.refrescadoEn ? `Datos actualizados: ${new Date(d.refrescadoEn).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })} (se refrescan cada 10 min).` : 'Sin datos en el periodo.'} Costos = mensajería (WhatsApp, correo, SMS).</p>
              <h2>Indicadores</h2>
              <dl className="p-kpis">
                {[
                  ['Leads', formatoNumero(k.leads)],
                  ['WhatsApp verificado', `${formatoNumero(k.verificados)} (${formatoPct(k.tasaVerificacion)})`],
                  ['Asistencias', formatoNumero(k.asistencias)],
                  ['No-show', formatoPct(k.tasaNoShow)],
                  ['Ocupación', `${formatoNumero(k.ocupacion.ocupadas)}/${formatoNumero(k.ocupacion.cupo)} (${formatoPct(k.ocupacion.tasa)})`],
                  ['Costo total', formatoMxn(k.costoMxn)],
                  ['Costo por lead', formatoMxn(k.costoPorLead)],
                  ['Costo por verificado', formatoMxn(k.costoPorVerificado)],
                  ['Costo por asistencia', formatoMxn(k.costoPorAsistencia)],
                  ['Mensajes fallidos', formatoNumero(k.mensajesFallidos)],
                ].map(([t, v]) => (
                  <div className="p-kpi" key={t}><dt>{t}</dt><dd>{v}</dd></div>
                ))}
              </dl>

              <h2>Funnel</h2>
              {d.funnel.length === 0 ? <p>Sin eventos en el periodo.</p> : d.funnel.slice(0, 6).map((g) => {
                const escala = escalaBarras(g.etapas.map((e) => e.total));
                const titulo = filtro.dimension === 'vacante' || filtro.dimension === 'cliente' ? nombre(g.clave) : g.clave;
                return (
                  <div className="p-scroll" key={g.clave} tabIndex={0} role="region" aria-label={`Funnel: ${titulo} (desplazable)`}>
                    <table className="p-tabla">
                      <caption>{DIMENSIONES.find(([v]) => v === filtro.dimension)?.[1]}: {titulo}</caption>
                      <thead><tr><th scope="col">Etapa</th><th scope="col" className="num">Total</th><th scope="col" className="num">Desde la etapa anterior</th><th scope="col">Gráfica</th></tr></thead>
                      <tbody>
                        {g.etapas.map((e, i) => (
                          <tr key={e.evento}>
                            <th scope="row">{e.etiqueta}</th>
                            <td className="num">{formatoNumero(e.total)}</td>
                            <td className="num">{formatoPct(e.tasaPaso)}</td>
                            <td className="p-barra-celda"><span className="p-barra" aria-hidden="true" style={{ width: `${escala[i]! * 100}%` }} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}

              <h2>Leads por día</h2>
              {d.serieLeads.length === 0 ? <p>Sin leads en el periodo.</p> : (
                <div className="p-scroll" tabIndex={0} role="region" aria-label="Leads por día (desplazable)">
                  <table className="p-tabla">
                    <caption>Leads por día</caption>
                    <thead><tr><th scope="col">Día</th><th scope="col" className="num">Leads</th><th scope="col">Gráfica</th></tr></thead>
                    <tbody>
                      {d.serieLeads.map((s, i) => (
                        <tr key={s.dia}><th scope="row">{s.dia}</th><td className="num">{formatoNumero(s.valor)}</td><td className="p-barra-celda"><span className="p-barra" aria-hidden="true" style={{ width: `${escalaSerie[i]! * 100}%` }} /></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h2>Por vacante</h2>
              <div className="p-scroll" tabIndex={0} role="region" aria-label="Indicadores por vacante (desplazable)">
                <table className="p-tabla">
                  <caption>Indicadores por vacante</caption>
                  <thead><tr><th scope="col">Vacante</th><th scope="col" className="num">Leads</th><th scope="col" className="num">Verificación</th><th scope="col" className="num">Ocupación</th><th scope="col" className="num">No-show</th><th scope="col" className="num">Costo por lead</th></tr></thead>
                  <tbody>
                    {d.porVacante.map((v) => (
                      <tr key={v.vacanteId}>
                        <th scope="row">{nombre(v.vacanteId)}</th>
                        <td className="num">{formatoNumero(v.kpis.leads)}</td>
                        <td className="num">{formatoPct(v.kpis.tasaVerificacion)}</td>
                        <td className="num">{formatoPct(v.kpis.ocupacion.tasa)}</td>
                        <td className="num">{formatoPct(v.kpis.tasaNoShow)}</td>
                        <td className="num">{formatoMxn(v.kpis.costoPorLead)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </EstadoCarga>
    </>
  );
}
