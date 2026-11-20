'use client';
import { Fragment, useState } from 'react';

const SECTORES = [
  { id: 'callcenter', tab: 'Call centers', titulo: ['Call', 'centers.'], texto: 'Asesores, ventas, cobranza, soporte, calidad y supervisión.' },
  { id: 'retail', tab: 'Autoservicios', titulo: ['Auto', 'servicios.'], texto: 'Piso de venta, cajas, almacén, inventarios y prevención.' },
  { id: 'restaurantes', tab: 'Restaurantes', titulo: ['Restau', 'rantes.'], texto: 'Cocina, servicio, caja, reparto y gerencia de unidad.' },
  { id: 'ventas', tab: 'Fuerza de ventas', titulo: ['Fuerza', 'de ventas.'], texto: 'Promotoría, cambaceo, ventas de campo y supervisión.' },
  { id: 'admin', tab: 'Administrativos', titulo: ['Áreas', 'admin.'], texto: 'Atención, compras, facturación, cobranza, RH y mandos medios.' },
  { id: 'ti', tab: 'Tecnología y TI', titulo: ['Tecnología', 'y TI.'], texto: 'Desarrollo, soporte, infraestructura, datos, ciberseguridad y liderazgo técnico.' },
];

/** Selector de sectores (pestañas accesibles). */
export function Sectores() {
  const [activo, setActivo] = useState('callcenter');
  return (
    <>
      <div className="sector-selector reveal reveal-delay" role="tablist" aria-label="Sectores">
        {SECTORES.map((s, i) => (
          <button key={s.id} type="button" role="tab" id={`tab-${s.id}`} aria-selected={activo === s.id} aria-controls="sector-panel" className={`sector-tab${activo === s.id ? ' active' : ''}`} onClick={() => setActivo(s.id)}>
            <span>{String(i + 1).padStart(2, '0')}</span> {s.tab} <b aria-hidden="true">↗</b>
          </button>
        ))}
      </div>
      <div className="sector-display reveal reveal-delay-2" id="sector-panel" role="tabpanel" aria-labelledby={`tab-${activo}`}>
        <div className="sector-display-top"><span className="display-kicker">Especialidad sectorial</span><span className="display-id">/ 369</span></div>
        {SECTORES.map((s) => (
          <div key={s.id} className={`sector-content${activo === s.id ? ' active' : ''}`} hidden={activo !== s.id}>
            <h3>{s.titulo.map((t, i) => <Fragment key={i}>{i === 0 ? t : <><br /><em>{t}</em></>}</Fragment>)}</h3>
            <p>{s.texto}</p>
          </div>
        ))}
        <div className="display-grid-lines"></div>
      </div>
    </>
  );
}
