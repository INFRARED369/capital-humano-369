/** Simulador salarial de la landing (contenido JSON → calculadora). */
export function calcularIngreso(c: { base_mensual: number; semanas_por_mes: number }, comisionSemanal: number) {
  const comisionMensual = comisionSemanal * c.semanas_por_mes;
  return { comisionMensual, total: c.base_mensual + comisionMensual };
}

export const formatoMxn = (n: number) => `$${n.toLocaleString('es-MX')}`;
