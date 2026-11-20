import type { Metadata } from 'next';
import { PanelShell } from '../../../components/panel/PanelShell';
import { Agenda } from '../../../components/panel/Agenda';

export const metadata: Metadata = { title: 'Agenda del día' };

export default function Pagina() {
  return (
    <PanelShell titulo="Agenda del día" actual="/panel/agenda/">
      <Agenda />
    </PanelShell>
  );
}
