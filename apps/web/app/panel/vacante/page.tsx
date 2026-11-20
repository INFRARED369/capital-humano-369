import type { Metadata } from 'next';
import { PanelShell } from '../../../components/panel/PanelShell';
import { EditorReglas } from '../../../components/panel/EditorReglas';

export const metadata: Metadata = { title: 'Reglas de la vacante' };

export default function Pagina() {
  return (
    <PanelShell titulo="Reglas de la vacante" actual="/panel/">
      <EditorReglas />
    </PanelShell>
  );
}
