import type { Metadata } from 'next';
import { PanelShell } from '../../../components/panel/PanelShell';
import { AltaAdmin } from '../../../components/panel/AltaAdmin';

export const metadata: Metadata = { title: 'Alta de clientes y vacantes' };

export default function Pagina() {
  return (
    <PanelShell titulo="Alta de clientes y vacantes" actual="/panel/admin/">
      <AltaAdmin />
    </PanelShell>
  );
}
