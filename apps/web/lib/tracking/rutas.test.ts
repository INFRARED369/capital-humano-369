import { describe, expect, it } from 'vitest';
import { rutaSinTerceros } from './rutas';

describe('rutaSinTerceros (panel y gestión de cita sin Pixel/Clarity)', () => {
  it.each(['/panel', '/panel/', '/panel/citas/', '/panel/acceso/', '/cita', '/cita/', '/cita/gestionar/', '/PANEL/agenda/'])('%s → excluida', (r) => {
    expect(rutaSinTerceros(r)).toBe(true);
  });
  it.each(['/', '/vacantes/agente-smart/', '/aviso-de-privacidad/', '/citas/', '/panelito/', '/vacantes/cita/', '', null, undefined])('%s → con tracking', (r) => {
    expect(rutaSinTerceros(r)).toBe(false);
  });
});
