/** Landing por vacante (CAP-01) a partir del contenido JSON validado. Estática; la interacción vive en componentes cliente. */
import type { ContenidoVacante } from '../../../../../src/domains/captacion';
import { Lineas, Rico } from '../Rico';
import { Revelar } from '../Revelar';
import { Calculadora } from './Calculadora';
import { FlujoPostulacion } from './FlujoPostulacion';
import { ContextoTracking, EnlaceCta, Faq, NavVacante } from './Interacciones';
import { VideoVacante } from './Video';
import { MapaDiferido } from './Mapa';
import { precargarFuentes } from '../../../lib/captacion/recursos';
import { IMG } from '../../../lib/captacion/recursos';

function Etiqueta({ num, texto, claro = false }: { num: string; texto: string; claro?: boolean }) {
  return (
    <div className={`section-label${claro ? ' section-label-claro' : ''}`}>
      <span className="num">{num}</span><span className="label-line"></span><span>{texto}</span>
    </div>
  );
}

export function LandingVacante({ c, vacantes }: { c: ContenidoVacante; vacantes: Array<{ slug: string; etiqueta: string }> }) {
  precargarFuentes();
  const wa = `https://wa.me/${c.whatsapp.numero}`;
  return (
    <div id="top">
      <ContextoTracking ctx={c.tracking} />
      <div className="noise" aria-hidden="true"></div>
      <div className="top-bar">
        <span className="badge-pulse">{c.barra_superior.insignia}</span> <Rico texto={c.barra_superior.texto} />
      </div>

      <header className="site-header">
        <div className="container nav-wrap">
          <a className="brand" href="/">
            <img src={IMG.logo.src} width={IMG.logo.width} height={IMG.logo.height} alt="Capital Humano 369" />
            <span className="brand-divider" aria-hidden="true"></span>
            <span className="brand-tag">Reclutamiento<br />por Vacante</span>
          </a>
          <NavVacante vacantes={vacantes} actual={c.slug} />
        </div>
      </header>

      <main>
        <section className="hero section-dark" id="inicio">
          <div className="container">
            <div className="hero-grid">
              <div>
                <p className="mockup-eyebrow">
                  {c.hero.eyebrow.map((e, i) => <span key={e} className="eyebrow-part">{i > 0 && <span aria-hidden="true"> / </span>}{e}</span>)} <i></i>
                </p>
                <h1><Lineas lineas={c.hero.titulo} /></h1>
                <p className="hero-lead"><Rico texto={c.hero.lead} /></p>
                <div className="hero-pills">
                  {c.hero.pills.map((p, i) => (
                    <div key={p.titulo} className="hero-pill">
                      <span className="hero-pill-index">{String(i + 1).padStart(2, '0')}</span>
                      <div><strong>{p.titulo}</strong><span>{p.detalle}</span></div>
                    </div>
                  ))}
                </div>
                <div className="hero-cta-group">
                  <EnlaceCta href="#postularme" className="btn btn-primary" ubicacion="HeroPrimary">{c.hero.cta_primario} <span aria-hidden="true">→</span></EnlaceCta>
                  <a href="#requisitos" className="btn btn-outline">{c.hero.cta_secundario}</a>
                </div>
              </div>
              <VideoVacante v={c.video} />
            </div>
            <div className="hero-stats-strip">
              {c.hero.stats.map((s) => <div key={s.valor} className="stat-cell"><strong>{s.valor}</strong><span>{s.detalle}</span></div>)}
            </div>
          </div>
        </section>

        <section className="section section-light" id="beneficios">
          <div className="container">
            <div className="section-header">
              <Etiqueta num="01" texto={c.beneficios.etiqueta} />
              <h2><Lineas lineas={c.beneficios.titulo} /></h2>
              {c.beneficios.intro && <p>{c.beneficios.intro}</p>}
            </div>
            <div className="offer-grid">
              <div>
                <div className="benefit-cards">
                  {c.beneficios.tarjetas.map((t) => (
                    <div key={t.indice} className="benefit-card"><span className="benefit-index">{t.indice}</span><h3>{t.titulo}</h3><p><Rico texto={t.texto} /></p></div>
                  ))}
                </div>
                {c.beneficios.funcion && (
                  <div className="info-panel info-panel-funcion">
                    <span className="benefit-index">{c.beneficios.funcion.indice}</span>
                    <h3>{c.beneficios.funcion.titulo}</h3>
                    <p className="txt-muted"><Rico texto={c.beneficios.funcion.texto} /></p>
                  </div>
                )}
              </div>
              {c.calculadora && <Calculadora c={c.calculadora} />}
            </div>
          </div>
        </section>

        <section className="section section-accent" id="requisitos">
          <div className="container">
            <div className="section-header section-header-claro">
              <Etiqueta num="02" texto={c.perfil.etiqueta} claro />
              <h2><Lineas lineas={c.perfil.titulo} /></h2>
              {c.perfil.intro && <p>{c.perfil.intro}</p>}
            </div>
            <div className="filter-columns">
              {c.perfil.columnas.map((col) => (
                <div key={col.tipo} className={`filter-box ${col.tipo === 'si' ? 'yes-box' : 'no-box'}`}>
                  <div className="filter-box-header">
                    <span className={`filter-badge ${col.tipo === 'si' ? 'yes' : 'no'}`}>{col.encabezado}</span>
                    <span className="filter-note">{col.nota}</span>
                  </div>
                  <ul className="filter-list">
                    {col.items.map((it) => (
                      <li key={it.titulo}>
                        <span className={col.tipo === 'si' ? 'icon-check' : 'icon-cross'} aria-hidden="true">{col.tipo === 'si' ? '✓' : '!'}</span>
                        <div><strong>{it.titulo}</strong> <Rico texto={it.texto} /></div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section section-light" id="ubicacion">
          <div className="container">
            <div className="section-header">
              <Etiqueta num="03" texto={c.ubicacion.etiqueta} />
              <h2><Lineas lineas={c.ubicacion.titulo} /></h2>
            </div>
            <div className="location-docs-grid">
              <div className="info-panel">
                <span className="benefit-index">{c.ubicacion.sitio.indice}</span>
                <h3>{c.ubicacion.sitio.titulo}</h3>
                <p className="txt-muted"><Rico texto={c.ubicacion.sitio.texto} /></p>
                <MapaDiferido titulo={`Mapa: ${c.ubicacion.direccion}`} src={c.ubicacion.mapa_embed} direccion={c.ubicacion.direccion} />
                <a href={c.ubicacion.mapa_link} target="_blank" rel="noopener noreferrer" className="btn btn-navy btn-block">Abrir Ubicación en Google Maps <span aria-hidden="true">↗</span></a>
              </div>
              <div className="info-panel">
                <span className="benefit-index">{c.ubicacion.documentos.indice}</span>
                <h3>{c.ubicacion.documentos.titulo}</h3>
                <p className="txt-muted"><Rico texto={c.ubicacion.documentos.intro} /></p>
                <ol className="docs-grid">
                  {c.ubicacion.documentos.items.map((d, i) => <li key={d} className="doc-item">{String(i + 1).padStart(2, '0')}. {d}</li>)}
                </ol>
                <div className="nota-pase"><strong>{c.ubicacion.documentos.nota.titulo}</strong><Rico texto={c.ubicacion.documentos.nota.texto} /></div>
              </div>
            </div>
          </div>
        </section>

        <section className="apply-section" id="postularme">
          <div className="container">
            <div className="section-header section-header-oscuro">
              <Etiqueta num="04" texto={c.postulacion.etiqueta} claro />
              <h2><Lineas lineas={c.postulacion.titulo} /></h2>
              {c.postulacion.intro && <p>{c.postulacion.intro}</p>}
            </div>
            <FlujoPostulacion slug={c.slug} vacante={c.menu_etiqueta} zonaHoraria={c.zona_horaria} preguntas={c.formulario.preguntas} pasos={c.postulacion.pasos} whatsapp={c.whatsapp} pase={c.pase} />
          </div>
        </section>

        <section className="section section-light" id="faq">
          <div className="container">
            <div className="section-header">
              <Etiqueta num="05" texto={c.faq.etiqueta} />
              <h2><Lineas lineas={c.faq.titulo} /></h2>
            </div>
            <Faq items={c.faq.items.map((f) => ({ pregunta: f.pregunta, respuesta: <Rico texto={f.respuesta} /> }))} />
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container footer-top">
          <a className="brand" href="/"><img src={IMG.logo.src} alt="Capital Humano 369" width={165} height={78} /></a>
          <p>El talento que mantiene tu<br /><em>operación</em> en movimiento.</p>
          <a className="btn btn-outline" href="#top">Volver arriba ↑</a>
        </div>
        <div className="container footer-bottom">
          <span>{c.footer.leyenda}</span>
          <span>{c.footer.direccion}</span>
          <span><a href={wa} target="_blank" rel="noopener noreferrer">WhatsApp Reclutamiento: {c.whatsapp.etiqueta}</a></span>
          <span><a href="/aviso-de-privacidad/">Aviso de Privacidad</a></span>
        </div>
      </footer>

      <div className="mobile-sticky-cta">
        <div><strong>{c.sticky.titulo}</strong><span>{c.sticky.detalle}</span></div>
        <EnlaceCta href="#postularme" className="btn btn-primary btn-sm" ubicacion="MobileSticky">{c.sticky.cta}</EnlaceCta>
      </div>
      <Revelar />
    </div>
  );
}
