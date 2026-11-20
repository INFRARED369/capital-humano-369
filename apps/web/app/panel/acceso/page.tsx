import type { Metadata } from 'next';
import { Acceso } from '../../../components/panel/Acceso';

export const metadata: Metadata = { title: 'Establecer contraseña', referrer: 'no-referrer' };

/** Destino del enlace de invitación / recuperación de Supabase Auth (redirect_to = /panel/acceso/). */
export default function Pagina() {
  return <Acceso />;
}
