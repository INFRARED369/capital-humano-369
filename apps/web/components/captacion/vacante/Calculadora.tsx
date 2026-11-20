'use client';
import { useState } from 'react';
import { calcularIngreso, formatoMxn } from '../../../lib/captacion/calculadora';
import { EnlaceCta } from './Interacciones';

export interface ConfigCalculadora { titulo: string; base_mensual: number; min: number; max: number; paso: number; inicial: number; semanas_por_mes: number }

export function Calculadora({ c }: { c: ConfigCalculadora }) {
  const [semanal, setSemanal] = useState(c.inicial);
  const { comisionMensual, total } = calcularIngreso(c, semanal);
  return (
    <aside className="calc-card" aria-labelledby="calc-titulo">
      <span className="kicker">Simulador Salarial 369</span>
      <h3 id="calc-titulo">{c.titulo}</h3>
      <p className="calc-sub">Mueve el deslizador según tus comisiones semanales (pagadas todos los viernes):</p>
      <div className="calc-slider-box">
        <div className="calc-slider-header">
          <label htmlFor="comision-semanal">Comisión semanal estimada:</label>
          <strong>{formatoMxn(semanal)} MXN / viernes</strong>
        </div>
        <input type="range" id="comision-semanal" className="range-slider" min={c.min} max={c.max} step={c.paso} value={semanal}
          aria-valuetext={`${formatoMxn(semanal)} pesos por semana`} onChange={(e) => setSemanal(Number(e.target.value))} />
        <div className="calc-escala">
          <span>MÍN: {formatoMxn(c.min)}/SEM</span><span>PROM: {formatoMxn(c.inicial)}/SEM</span><span>DESTACADO: {formatoMxn(c.max)}+/SEM</span>
        </div>
      </div>
      <div className="calc-breakdown" aria-live="polite">
        <div className="calc-row"><span>Sueldo base libre (2 quincenas):</span><strong>{formatoMxn(c.base_mensual)} MXN</strong></div>
        <div className="calc-row"><span>Comisiones al mes ({c.semanas_por_mes} viernes):</span><strong>{formatoMxn(comisionMensual)} MXN</strong></div>
        <div className="calc-row"><span>Límite de comisiones:</span><strong className="txt-lime">SIN TOPE</strong></div>
      </div>
      <div className="calc-total-box"><span>Ingreso Mensual Estimado</span><strong>{formatoMxn(total)} MXN libres/mes</strong></div>
      <EnlaceCta href="#postularme" className="btn btn-primary btn-block" ubicacion="CalculatorCard">Postularme Ahora <span aria-hidden="true">→</span></EnlaceCta>
    </aside>
  );
}
