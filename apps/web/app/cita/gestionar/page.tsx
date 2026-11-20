import type { Metadata } from 'next';
import '../../../components/panel/panel.css';
import { GestionCita } from '../../../components/panel/GestionCita';

/** CIT-11 / E2E-10: gestión de la cita con el link firmado (`?t=<token>`). /cita/?t= es el formato que arma comunicación. */
export const metadata: Metadata = {
  title: 'Gestiona tu cita | 369 Capital Humano',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function Pagina() {
  return <GestionCita />;
}
