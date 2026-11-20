/**
 * Aviso de privacidad integral (CAP-08, NFR-PRIV-01). Versionado: la versión que acepta el candidato se guarda
 * con su lead (consentimiento_version). PENDIENTE DE REVISIÓN LEGAL (Q-3) antes de publicarse en producción.
 */
import type { Metadata } from 'next';
import '../../components/captacion/portada.css';
import { PiePortada } from '../../components/captacion/portada/PiePortada';
import { configPublica } from '../../lib/config';
import { IMG } from '../../lib/captacion/recursos';

export const metadata: Metadata = {
  title: 'Aviso de Privacidad | Capital Humano 369',
  description: 'Cómo Capital Humano 369 trata tus datos personales en sus procesos de reclutamiento y contacto comercial.',
};

const ENCARGADOS: Array<[string, string]> = [
  ['Supabase', 'Base de datos y funciones del sistema donde se guardan tu registro y tu cita.'],
  ['Whatsapp', 'Validar que tu número exista en WhatsApp y enviarte el código de verificación, la confirmación y los recordatorios de tu cita.'],
  ['Zoho (Zoho Calendar)', 'Mostrar la agenda al reclutador de la vacante. Solo recibe tu folio, tu nombre de pila y el horario; nunca tu teléfono.'],
  ['Meta Platforms (Pixel y API de Conversiones)', 'Medir y optimizar campañas. Solo recibe datos cifrados con hash (SHA-256) y únicamente si aceptas las cookies de medición.'],
  ['Google (Analytics 4, Tag Manager y Maps)', 'Medir campañas y mostrar el mapa de la ubicación de la vacante. La medición solo se activa si aceptas las cookies.'],
  ['Microsoft Clarity', 'Entender el uso del sitio con grabaciones que enmascaran todos los campos y textos con datos. Solo con tu aceptación.'],
  ['Cloudflare (Turnstile)', 'Proteger los formularios contra bots.'],
];

const PLAZOS: Array<[string, string]> = [
  ['Registro sin verificar tu WhatsApp', '48 horas; después se borra por completo.'],
  ['Código de verificación', 'Solo se guarda cifrado con hash; vence en 10 minutos y se borra a las 24 horas.'],
  ['Registro con cita cancelada o a la que no asististe', 'Fecha de la cita + 30 días; luego 30 días de bloqueo y anonimización.'],
  ['Registro con entrevista realizada', 'Fecha de la cita + 90 días; luego 30 días de bloqueo y anonimización.'],
  ['Datos de navegación con tu consentimiento', '90 días; después solo quedan conteos anónimos.'],
  ['Solicitudes de empresas (formulario de contacto)', '180 días; después se anonimizan.'],
];

export default function AvisoPrivacidad() {
  const version = configPublica.versionAviso;
  return (
    <>
      <header className="site-header scrolled" id="top">
        <div className="container nav-wrap">
          <a className="brand" href="/" aria-label="Capital Humano 369, inicio"><img src={IMG.logo.src} width={IMG.logo.width} height={IMG.logo.height} alt="Capital Humano 369" /></a>
        </div>
      </header>
      <main className="aviso section-light">
        <div className="container aviso-contenido">
          <p className="aviso-pendiente" role="note">Versión {version} </p>
          <h1>Aviso de Privacidad</h1>
          <p>Versión <strong>{version}</strong>. Al postularte o enviarnos una solicitud aceptas expresamente esta versión, y la guardamos junto con tu registro como prueba de tu consentimiento.</p>

          <h2>1. Responsable</h2>
          <p>Capital Humano 369, con domicilio en Pino Suarez #455A, Monterrey Centro, Monterrey, Nuevo León, C.P. 64000, es responsable del tratamiento de tus datos personales conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares. Cuando reclutamos para una empresa cliente, esa empresa recibe tu información para decidir tu contratación.</p>

          <h2>2. Datos que recabamos</h2>
          <ul>
            <li>Candidatos: nombre, número de WhatsApp, correo (opcional), las respuestas al formulario de la vacante, el horario de entrevista que elijas y la versión de este aviso que aceptaste.</li>
            <li>Empresas: nombre, empresa, correo corporativo, servicio de interés y el mensaje que nos envíes.</li>
            <li>Navegación (solo si aceptas cookies): identificador del visitante, origen de la campaña (UTM, fbclid, gclid) y los eventos del sitio.</li>
          </ul>
          <p>No recabamos datos personales sensibles. Las respuestas del formulario nunca descalifican tu postulación; las usa el reclutador para preparar tu entrevista.</p>

          <h2>3. Finalidades</h2>
          <ul>
            <li>Primarias: registrar tu postulación, verificar tu WhatsApp, agendar y confirmar tu entrevista, enviarte recordatorios y dar seguimiento al proceso; atender solicitudes de servicio de empresas.</li>
            <li>Secundarias (puedes negarte sin afectar tu postulación): medir y optimizar nuestras campañas de reclutamiento.</li>
          </ul>

          <h2>4. Encargados y transferencias</h2>
          <p>Compartimos los datos mínimos necesarios con estos proveedores, que actúan como encargados por cuenta de Capital Humano 369:</p>
          <ul>{ENCARGADOS.map(([n, d]) => <li key={n}><strong>{n}:</strong> {d}</li>)}</ul>
          <p>Además, la empresa cliente de la vacante recibe tu información para el proceso de selección.</p>

          <h2>5. Cuánto tiempo conservamos tus datos</h2>
          <ul>{PLAZOS.map(([d, p]) => <li key={d}><strong>{d}:</strong> {p}</li>)}</ul>

          <h2>6. Derechos ARCO y revocación del consentimiento</h2>
          <p>Puedes acceder, rectificar, cancelar u oponerte al uso de tus datos, así como revocar tu consentimiento, escribiendo a <a href="mailto:privacidad@369capitalhumano.com">privacidad@369capitalhumano.com</a>. Responderemos dentro de los 20 días hábiles que marca la ley. Si revocas tu consentimiento borramos tu registro, cancelamos los mensajes pendientes y dejamos de contactarte.</p>

          <h2>7. Cookies y tecnologías de rastreo</h2>
          <p>Las herramientas de medición (Meta, Google y Clarity) solo se activan si las aceptas en el aviso de cookies. Puedes cambiar tu decisión en cualquier momento.</p>

          <h2>8. Cambios a este aviso</h2>
          <p>Publicaremos cualquier cambio en esta página con una nueva versión y fecha.</p>
          <p><a className="button button-dark" href="/">Volver al inicio</a></p>
        </div>
      </main>
      <PiePortada inicio="/" />
    </>
  );
}
