/**
 * COM-02 · PoliticaReintento: 1 intento + `maxReintentos` reintentos con backoff exponencial;
 * al agotarse (o ante un error permanente) → dead letter + MensajeFallido.
 */
export type DecisionReintento = { accion: 'reintentar'; backoffSeg: number } | { accion: 'dead_letter' };

export interface PoliticaReintento {
  readonly maxIntentos: number;
  /** `intento` = número del intento que acaba de fallar (1-based). */
  decidir(intento: number, error?: { permanente?: boolean }): DecisionReintento;
}

export interface OpcionesPolitica {
  maxReintentos?: number;
  baseSeg?: number;
  factor?: number;
  topeSeg?: number;
}

export function crearPoliticaReintento({ maxReintentos = 2, baseSeg = 30, factor = 4, topeSeg = 3600 }: OpcionesPolitica = {}): PoliticaReintento {
  if (!Number.isInteger(maxReintentos) || maxReintentos < 0) throw new RangeError('maxReintentos inválido');
  if (!(baseSeg > 0) || !(factor >= 1) || !(topeSeg >= baseSeg)) throw new RangeError('backoff inválido');
  const maxIntentos = maxReintentos + 1;
  return {
    maxIntentos,
    decidir(intento, error) {
      if (error?.permanente || intento >= maxIntentos) return { accion: 'dead_letter' };
      return { accion: 'reintentar', backoffSeg: Math.min(topeSeg, Math.round(baseSeg * factor ** (intento - 1))) };
    },
  };
}

export const POLITICA_DEFECTO = crearPoliticaReintento();
