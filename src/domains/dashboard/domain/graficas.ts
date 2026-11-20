/** Utilidades puras para gráficas simples y accesibles del panel (barras con texto, sin canvas). */
export function escalaBarras(valores: readonly number[], maximo?: number): number[] {
  const limpios = valores.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const max = maximo ?? Math.max(0, ...limpios);
  return limpios.map((v) => (max > 0 ? Math.min(1, v / max) : 0));
}

const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const entero = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

export const formatoMxn = (v: number | null): string => (v === null ? '—' : mxn.format(v));
export const formatoPct = (v: number | null): string => (v === null ? '—' : `${(Math.round(v * 1000) / 10).toFixed(1)} %`);
export const formatoNumero = (v: number | null): string => (v === null ? '—' : entero.format(v));
