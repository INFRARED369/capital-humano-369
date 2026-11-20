import type { Metadata } from 'next';
import { PanelShell } from '../../../components/panel/PanelShell';
import { DetalleCita } from '../../../components/panel/DetalleCita';

export const metadata: Metadata = { title: 'Detalle de la cita' };

export default function Pagina() {
  return (
    <PanelShell titulo="Detalle de la cita" actual="/panel/agenda/">
      <DetalleCita />
    </PanelShell>
  );
}
