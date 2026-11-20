/** Portada (/) portada desde el index.html legado. Contenido estático; interacción en componentes cliente. */
import type { Metadata } from 'next';
import '../components/captacion/portada.css';
import { IconoWhatsApp } from '../components/captacion/IconoWhatsApp';
import { Revelar } from '../components/captacion/Revelar';
import { FormularioB2B } from '../components/captacion/portada/FormularioB2B';
import { NavPrincipal } from '../components/captacion/portada/NavPrincipal';
import { PiePortada } from '../components/captacion/portada/PiePortada';
import { Sectores } from '../components/captacion/portada/Sectores';
import { menuVacantes } from '../lib/captacion/contenido';
import { IMG, precargarFuentes } from '../lib/captacion/recursos';

export const metadata: Metadata = {
  title: 'Capital Humano 369 — El talento que mueve tu operación',
  description: 'Capital Humano 369 ayuda a empresas con operación intensiva a cubrir, preparar y administrar talento operativo, administrativo y mandos medios.',
};

const SERVICIOS_HERO: Array<[string, string, string]> = [
  ['♟', 'Reclutamiento\ny selección', '#servicios'], ['◆', 'Capacitación\ny DNC', '#servicios'], ['▤', 'Administración\nde nómina', '#servicios'],
  ['▥', 'Evaluaciones\n369', '#servicios'], ['◉', 'Call centers', '#sectores'], ['🛒', 'Autoservicios', '#sectores'], ['♜', 'Restaurantes', '#sectores'],
  ['↗', 'Fuerza de ventas', '#sectores'], ['▣', 'Administrativos', '#sectores'], ['⌘', 'Tecnología\ny TI', '#sectores'],
];

const SERVICIOS: Array<{ titulo: React.ReactNode; sub: string; detalle: string; aria: string }> = [
  { titulo: <>Reclutamiento <span>&amp;</span> selección</>, sub: 'Masivo, especializado y headhunting selectivo.', detalle: 'Perfilamos, atraemos, filtramos y acompañamos hasta el ingreso.', aria: 'Solicitar reclutamiento' },
  { titulo: <>Capacitación <span>&amp;</span> DNC</>, sub: 'Diagnóstico que se convierte en desempeño.', detalle: 'Detectamos brechas y las traducimos en planes que sí llegan al puesto.', aria: 'Solicitar capacitación' },
  { titulo: <>Administración<br />de nómina</>, sub: 'Orden, control y trazabilidad.', detalle: 'Maquila y administración con calendarios claros, reportes y revisión especializada.', aria: 'Solicitar administración de nómina' },
  { titulo: <>Evaluaciones <span>369</span></>, sub: 'Decisiones con más evidencia.', detalle: 'Psicometría, referencias y estudios socioeconómicos alineados al puesto.', aria: 'Solicitar evaluaciones' },
];

const METODO = [
  { n: '01', clase: '', icono: '◌', titulo: 'Entendemos', texto: 'Escuchamos tu operación, el puesto y el reto que quieres resolver.', delay: '' },
  { n: '02', clase: ' step-shape-orange', icono: '⌁', titulo: 'Alineamos', texto: 'Construimos el perfil, la estrategia y los criterios de éxito.', delay: ' reveal-delay' },
  { n: '03', clase: ' step-shape-dark', icono: '↗', titulo: 'Movemos', texto: 'Atraemos, evaluamos, decidimos y ponemos el talento en acción.', delay: ' reveal-delay-2' },
  { n: '04', clase: ' step-shape-lime', icono: '✦', titulo: 'Acompañamos', texto: 'Medimos permanencia, desempeño y oportunidades de mejora.', delay: ' reveal-delay-3' },
];

const conSaltos = (t: string) => t.split('\n').flatMap((l, i) => (i ? [<br key={i} />, l] : [l]));

export default function Portada() {
  precargarFuentes();
  return (
    <>
      <div className="noise" aria-hidden="true"></div>
      <NavPrincipal vacantes={menuVacantes()} />
      <main>
        <section className="hero mockup-hero section-dark" id="inicio">
          <div className="container mockup-hero-inner">
            <div className="mockup-hero-top">
              <div className="hero-copy reveal">
                <p className="mockup-eyebrow">PERSONAS <span>/</span> PROCESOS <span>/</span> RESULTADOS <i></i></p>
                <h1>El talento que<br /><strong>mantiene tu</strong><br />operación en<br /><b>movimiento.</b></h1>
                <p className="hero-lead">Soluciones de capital humano para empresas que nunca se detienen.</p>
                <div className="hero-actions">
                  <a className="button button-primary" href="#contacto">Solicitar diagnóstico <span aria-hidden="true">↗</span></a>
                  <a className="mockup-play" href="#metodo"><span aria-hidden="true">▶</span><small>Conoce<br />cómo lo hacemos</small></a>
                </div>
              </div>
              <div className="hero-visual reveal reveal-delay" aria-hidden="true">
                <div className="orbit orbit-one"></div><div className="orbit orbit-two"></div>
                <div className="hero-card hero-card-main">
                  <span className="card-kicker">Personas de hoy para<br />un mejor mañana.</span>
                  <div className="card-figure"><span className="figure-bar"></span><span className="figure-bar short"></span><span className="figure-bar tiny"></span></div>
                  <div className="card-foot"><span>Talento<br />estrategia<br />resultados</span><strong>Proceso 369<br />01 — 05</strong></div>
                </div>
                <div className="hero-sticker"><img src={IMG.marca.src} width={IMG.marca.width} height={IMG.marca.height} alt="" /><small>visión<br />humana</small></div>
              </div>
              <div className="hero-rail" aria-hidden="true"><i></i><span>MÁS<br />PERSONAS<br />MÁS<br />POSIBILIDADES</span><i></i><span>MÉXICO<br />TRABAJA<br />CON TALENTO</span></div>
            </div>
            <div className="mockup-services mockup-services-10 reveal reveal-delay-2">
              {SERVICIOS_HERO.map(([icono, texto, href]) => (
                <a key={texto} href={href}><span className="service-icon" aria-hidden="true">{icono}</span><strong>{conSaltos(texto)}</strong></a>
              ))}
            </div>
            <div className="mockup-stats mockup-stats-centered reveal reveal-delay-3">
              <span>Talento<br />que impulsa<br />tu operación</span><strong>+30<small>Empresas que confían</small></strong><strong>+6000<small>Personas colocadas</small></strong>
            </div>
          </div>
        </section>

        <section className="intro section-light" id="nosotros">
          <div className="container intro-grid">
            <div className="section-label reveal"><span>01</span><span className="label-line"></span><span>Lo que hacemos</span></div>
            <div className="intro-copy reveal reveal-delay">
              <h2>No llenamos vacantes.<br /><span>Movemos negocios.</span></h2>
              <p>Capital Humano 369 es el socio operativo de RH para organizaciones que viven al ritmo de su gente. Diseñamos soluciones que empiezan en el perfil correcto y continúan después del ingreso.</p>
              <a className="arrow-link" href="#metodo">Conoce nuestra forma de trabajar <span aria-hidden="true">↗</span></a>
            </div>
            <div className="intro-aside reveal reveal-delay-2"><div className="big-number"><img src={IMG.marca.src} width={IMG.marca.width} height={IMG.marca.height} alt="369" /></div><p>Un ciclo completo para conectar estrategia, personas y operación.</p></div>
          </div>
        </section>

        <section className="services section-dark" id="servicios">
          <div className="container">
            <div className="section-heading reveal">
              <div className="section-label section-label-light"><span>02</span><span className="label-line"></span><span>Capacidades</span></div>
              <h2>Una solución para<br /><em>cada movimiento.</em></h2>
              <p>Servicios modulares que se integran a la realidad de tu operación.</p>
            </div>
            <div className="services-list">
              {SERVICIOS.map((s, i) => (
                <article key={s.aria} className="service-row reveal">
                  <div className="service-index">{String(i + 1).padStart(2, '0')}</div>
                  <div className="service-title"><h3>{s.titulo}</h3><p>{s.sub}</p></div>
                  <div className="service-detail">{s.detalle}</div>
                  <a className="service-arrow" href="#contacto" aria-label={s.aria}>↗</a>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="sectors section-accent" id="sectores">
          <div className="container sectors-grid">
            <div className="sectors-head reveal">
              <div className="section-label"><span>03</span><span className="label-line label-line-dark"></span><span>Donde aportamos</span></div>
              <h2>Hechos para<br /><span>la operación real.</span></h2>
              <p>Conocemos la presión de una vacante abierta, una sucursal por arrancar y un equipo que necesita rendir desde el día uno.</p>
            </div>
            <Sectores />
          </div>
        </section>

        <section className="method section-light" id="metodo">
          <img className="method-brand-watermark" src={IMG.marca.src} width={IMG.marca.width} height={IMG.marca.height} alt="" aria-hidden="true" />
          <div className="container">
            <div className="method-top reveal">
              <div className="section-label"><span>04</span><span className="label-line"></span><span>Método 369</span></div>
              <div className="method-statement">Del primer diagnóstico<br /><strong>al siguiente nivel.</strong></div>
            </div>
            <div className="method-track">
              {METODO.map((m) => (
                <article key={m.n} className={`method-step reveal${m.delay}`}>
                  <span className="step-number">{m.n}</span>
                  <div className={`step-shape${m.clase}`} aria-hidden="true"><span>{m.icono}</span></div>
                  <h3>{m.titulo}</h3><p>{m.texto}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="promise section-dark" id="promesa">
          <div className="container promise-inner reveal">
            <div className="promise-mark"><img src={IMG.marcaNaranja.src} width={IMG.marcaNaranja.width} height={IMG.marcaNaranja.height} alt="369 visión humana" /></div>
            <div><p className="eyebrow"><span className="eyebrow-dot"></span> Más que cobertura</p><h2>La diferencia se nota<br /><em>después de contratar.</em></h2></div>
            <div className="promise-copy"><p>Velocidad para responder. Calidad para elegir. Acompañamiento para permanecer.</p><a className="button button-outline" href="#contacto">Hablemos de tu operación <span aria-hidden="true">↗</span></a></div>
          </div>
        </section>

        <section className="contact section-light" id="contacto">
          <div className="container contact-grid">
            <div className="contact-copy reveal">
              <div className="section-label"><span>05</span><span className="label-line"></span><span>Conversemos</span></div>
              <h2>Cuéntanos qué<br /><span>necesitas mover.</span></h2>
              <p>Cuéntanos sobre tu operación y te ayudamos a encontrar el siguiente paso: una vacante, un equipo, una capacitación o un proceso más ordenado.</p>
              <div className="contact-meta">
                <div><span className="meta-label">Correo</span><a href="mailto:hola@369capitalhumano.com">hola@369capitalhumano.com</a></div>
                <div><span className="meta-label">Teléfono</span><a href="tel:+528134700891">81 3470 0891</a></div>
                <div><span className="meta-label">WhatsApp</span><a className="whatsapp-link" href="https://wa.me/528134700891" target="_blank" rel="noopener noreferrer"><IconoWhatsApp /><span>Escríbenos por WhatsApp</span><span aria-hidden="true">↗</span></a></div>
                <div><span className="meta-label">Respuesta</span><strong>En horario laboral</strong></div>
                <div className="contact-address"><span className="meta-label">Visítanos</span><strong>Pino Suarez #455A<br />Monterrey Centro, Monterrey,<br />Nuevo León · CP 64000</strong></div>
              </div>
            </div>
            <FormularioB2B />
          </div>
        </section>
      </main>
      <PiePortada />
      <Revelar />
    </>
  );
}
