import type { Metadata } from 'next';
import { PanelShell } from '../../../components/panel/PanelShell';
import { Dashboard } from '../../../components/panel/Dashboard';

export const metadata: Metadata = { title: 'Dashboard' };

export default function Pagina() {
  return (
    <PanelShell titulo="Dashboard" actual="/panel/dashboard/">
      <Dashboard />
    </PanelShell>
  );
}
