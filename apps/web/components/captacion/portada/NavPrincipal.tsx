'use client';
import { useEffect, useState } from 'react';
import { IMG } from '../../../lib/captacion/recursos';

/** Encabezado de la portada: menú móvil, desplegable "Vacantes Premium" y sombra al hacer scroll. */
export function NavPrincipal({ vacantes }: { vacantes: Array<{ slug: string; etiqueta: string }> }) {
  const [abierto, setAbierto] = useState(false);
  const [desplegable, setDesplegable] = useState(false);
  const [scroll, setScroll] = useState(false);

  useEffect(() => {
    const alScroll = () => setScroll(window.scrollY > 45);
    const cerrar = () => setDesplegable(false);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDesplegable(false); setAbierto(false); } };
    window.addEventListener('scroll', alScroll, { passive: true });
    document.addEventListener('click', cerrar);
    document.addEventListener('keydown', esc);
    return () => { window.removeEventListener('scroll', alScroll); document.removeEventListener('click', cerrar); document.removeEventListener('keydown', esc); };
  }, []);

  const cerrarMenu = () => setAbierto(false);
  return (
    <header className={`site-header${scroll ? ' scrolled' : ''}`} id="top">
      <div className="container nav-wrap">
        <a className="brand" href="#inicio" aria-label="Capital Humano 369, inicio">
          <img src={IMG.logo.src} width={IMG.logo.width} height={IMG.logo.height} alt="Capital Humano 369" />
        </a>
        <button className="menu-toggle" type="button" aria-label={abierto ? 'Cerrar menú' : 'Abrir menú'} aria-expanded={abierto} aria-controls="nav-principal" onClick={() => setAbierto((v) => !v)}>
          <span></span><span></span>
        </button>
        <nav className={`main-nav${abierto ? ' open' : ''}`} id="nav-principal" aria-label="Navegación principal">
          <a href="#servicios" onClick={cerrarMenu}>Servicios</a>
          <a href="#sectores" onClick={cerrarMenu}>Sectores</a>
          <a href="#metodo" onClick={cerrarMenu}>Método 369</a>
          <a href="#nosotros" onClick={cerrarMenu}>Nosotros</a>
          <div className={`nav-dropdown${desplegable ? ' open' : ''}`}>
            <button type="button" className="nav-dropdown-trigger" aria-expanded={desplegable} aria-controls="menu-vacantes" onClick={(e) => { e.stopPropagation(); setDesplegable((v) => !v); }}>
              Vacantes Premium <span className="dropdown-caret" aria-hidden="true">▾</span>
            </button>
            <div className="nav-dropdown-menu" id="menu-vacantes" aria-label="Vacantes Premium">
              {vacantes.map((v) => (
                <a key={v.slug} href={`/vacantes/${v.slug}/`} className="nav-dropdown-item">{v.etiqueta}</a>
              ))}
            </div>
          </div>
          <a className="nav-cta" href="#contacto" onClick={cerrarMenu}>Hablemos <span aria-hidden="true">↗</span></a>
        </nav>
      </div>
    </header>
  );
}
