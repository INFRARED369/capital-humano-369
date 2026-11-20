import type { Metadata } from 'next';
import { PanelShell } from '../../components/panel/PanelShell';
import { ListaVacantes } from '../../components/panel/ListaVacantes';

export const metadata: Metadata = { title: 'Vacantes' };

export default function Pagina() {
  return (
    <PanelShell titulo="Vacantes" actual="/panel/">
      <ListaVacantes />
    </PanelShell>
  );
}
