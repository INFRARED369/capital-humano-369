'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { fijarContextoVacante, track, type ContextoVacante } from '../../../lib/tracking';

/** Fija el contexto de la vacante en el SDK de tracking (vacancy_id, client_id, content_category; D10/TRK-08). */
export function ContextoTracking({ ctx }: { ctx: ContextoVacante }) {
  useEffect(() => {
    fijarContextoVacante(ctx);
    return () => fijarContextoVacante(null);
  }, [ctx]);
  return null;
}

/** Enlace de llamada a la acción que registra ClickCTA con su ubicación. */
export function EnlaceCta({ href, ubicacion, className, children }: { href: string; ubicacion: string; className?: string; children: ReactNode }) {
  return <a href={href} className={className} onClick={() => track('ClickCTA', { location: ubicacion })}>{children}</a>;
}

export function NavVacante({ vacantes, actual }: { vacantes: Array<{ slug: string; etiqueta: string }>; actual: string }) {
  const [abierto, setAbierto] = useState(false);
  useEffect(() => {
    const cerrar = () => setAbierto(false);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('click', cerrar);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', cerrar); document.removeEventListener('keydown', esc); };
  }, []);
  return (
    <nav className="main-nav" aria-label="Navegación de la vacante">
      <a href="#beneficios">01. Ofrecimiento</a>
      <a href="#requisitos">02. Requisitos</a>
      <a href="#ubicacion">03. Ubicación y Papelería</a>
      <a href="#faq">04. Preguntas</a>
      <div className={`nav-dropdown${abierto ? ' open' : ''}`}>
        <button type="button" className="nav-dropdown-trigger" aria-expanded={abierto} aria-controls="menu-vacantes" onClick={(e) => { e.stopPropagation(); setAbierto((v) => !v); }}>
          Vacantes Premium <span className="dropdown-caret" aria-hidden="true">▾</span>
        </button>
        <div className="nav-dropdown-menu" id="menu-vacantes" aria-label="Vacantes Premium">
          {vacantes.map((v) => (
            <a key={v.slug} href={`/vacantes/${v.slug}/`} className={`nav-dropdown-item${v.slug === actual ? ' active' : ''}`} aria-current={v.slug === actual ? 'page' : undefined}>{v.etiqueta}</a>
          ))}
          <a href="/" className="nav-dropdown-item">← Volver al sitio oficial 369</a>
        </div>
      </div>
      <EnlaceCta className="nav-cta" href="#postularme" ubicacion="Navbar">Agendar Entrevista <span aria-hidden="true">↗</span></EnlaceCta>
    </nav>
  );
}

export function Faq({ items }: { items: Array<{ pregunta: string; respuesta: ReactNode }> }) {
  const [abiertos, setAbiertos] = useState<Set<number>>(new Set([0]));
  const alternar = (i: number) => setAbiertos((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <div className="faq-list">
      {items.map((it, i) => (
        <div key={i} className={`faq-item${abiertos.has(i) ? ' open' : ''}`}>
          <button type="button" className="faq-question" aria-expanded={abiertos.has(i)} aria-controls={`faq-${i}`} onClick={() => alternar(i)}>
            <span>{it.pregunta}</span><span aria-hidden="true">{abiertos.has(i) ? '−' : '+'}</span>
          </button>
          <div className="faq-answer" id={`faq-${i}`}>{it.respuesta}</div>
        </div>
      ))}
    </div>
  );
}
