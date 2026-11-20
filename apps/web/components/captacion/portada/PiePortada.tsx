import { IconoWhatsApp } from '../IconoWhatsApp';
import { IMG } from '../../../lib/captacion/recursos';

export function PiePortada({ inicio = '#top' }: { inicio?: string }) {
  return (
    <footer className="site-footer section-dark">
      <div className="container footer-top">
        <a className="brand footer-brand" href={inicio}><img src={IMG.logo.src} width={IMG.logo.width} height={IMG.logo.height} alt="Capital Humano 369" /></a>
        <p>El talento que mantiene tu<br /><em>operación</em> en movimiento.</p>
        <a className="back-top" href="#top">Volver arriba <span aria-hidden="true">↑</span></a>
      </div>
      <div className="container footer-bottom">
        <span>© 2026 Capital Humano 369</span>
        <span>
          <a href="tel:+528134700891">81 3470 0891</a> ·{' '}
          <a className="whatsapp-link" href="https://wa.me/528134700891" target="_blank" rel="noopener noreferrer"><IconoWhatsApp /><span>WhatsApp</span><span aria-hidden="true">↗</span></a>
        </span>
        <span>Pino Suarez #455A · Monterrey Centro · CP 64000</span>
        <span><a href="/aviso-de-privacidad/">Aviso de Privacidad</a></span>
        <span>Diseño / 369</span>
      </div>
    </footer>
  );
}
