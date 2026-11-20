/** COM-06 · Recordatorios 24 h y 2 h (configurables) antes de la cita, dentro de la ventana de contacto. */
import type { ReglasMensajes } from './plantillas.ts';
import { ajustarAVentana } from './ventana.ts';

export interface RecordatorioProgramado {
  tipo: 'recordatorio_24h' | 'recordatorio_2h';
  programadoPara: string;
}

/** Margen mínimo entre un recordatorio y la cita; si el ajuste a la ventana lo empuja más allá, se omite. */
const MARGEN_MIN_MS = 30 * 60_000;

export function programarRecordatorios(inicioCita: Date, ahora: Date, reglas: ReglasMensajes): RecordatorioProgramado[] {
  const salida: RecordatorioProgramado[] = [];
  const pares = [
    ['recordatorio_24h', reglas.recordatorios.h24],
    ['recordatorio_2h', reglas.recordatorios.h2],
  ] as const;
  for (const [tipo, cfg] of pares) {
    if (!cfg.activo) continue;
    const bruto = new Date(inicioCita.getTime() - cfg.horas_antes * 3_600_000);
    if (bruto <= ahora) continue;
    const ajustado = ajustarAVentana(bruto, reglas.ventana_contacto, tipo);
    if (inicioCita.getTime() - ajustado.getTime() < MARGEN_MIN_MS) continue;
    salida.push({ tipo, programadoPara: ajustado.toISOString() });
  }
  return salida;
}
