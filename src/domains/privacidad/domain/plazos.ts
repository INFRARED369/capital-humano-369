/**
 * Días hábiles en México y plazos ARCO (Política de retención §3, PRV-02). Puro, sin I/O.
 *
 * - Inhábiles: sábados, domingos y los descansos obligatorios del art. 74 de la LFT. La autoridad
 *   puede publicar días inhábiles adicionales (p. ej. Semana Santa): se pasan en `inhabiles`.
 * - El conteo empieza el día hábil SIGUIENTE a la recepción, en la fecha civil de America/Mexico_City.
 * - Plazos (LFPDPPP): 20 días hábiles para responder y 15 días hábiles más para hacer efectiva la
 *   solicitud procedente. ⚖️ Pendiente de validación legal (Q-3): ajustar aquí si el abogado indica otros.
 */
export const ZONA_MX = 'America/Mexico_City';
export const PLAZO_RESPUESTA_DIAS_HABILES = 20;
export const PLAZO_EJECUCION_DIAS_HABILES = 15;

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** n-ésimo lunes del mes (m: 1..12). */
function enesimoLunes(y: number, m: number, n: number): string {
  const primero = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0 = domingo
  const dia = 1 + ((8 - primero) % 7) + (n - 1) * 7;
  return iso(y, m, dia);
}

/** Descansos obligatorios (LFT art. 74). */
export function festivosMexico(y: number): Set<string> {
  const f = new Set([
    iso(y, 1, 1),
    enesimoLunes(y, 2, 1), // 5 de febrero → primer lunes
    enesimoLunes(y, 3, 3), // 21 de marzo → tercer lunes
    iso(y, 5, 1),
    iso(y, 9, 16),
    enesimoLunes(y, 11, 3), // 20 de noviembre → tercer lunes
    iso(y, 12, 25),
  ]);
  if ((y - 2024) % 6 === 0) f.add(iso(y, 10, 1)); // transmisión del Poder Ejecutivo Federal
  return f;
}

const formato = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_MX, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Fecha civil (YYYY-MM-DD) en America/Mexico_City. */
export function fechaLocal(d: Date): string {
  return formato.format(d);
}

const diaSemana = (fecha: string) => new Date(`${fecha}T12:00:00Z`).getUTCDay();
const siguiente = (fecha: string) => new Date(Date.parse(`${fecha}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function esDiaHabil(fecha: string, inhabiles: readonly string[] = []): boolean {
  const dow = diaSemana(fecha);
  if (dow === 0 || dow === 6) return false;
  if (inhabiles.includes(fecha)) return false;
  return !festivosMexico(Number(fecha.slice(0, 4))).has(fecha);
}

/** Fecha local que resulta de contar `n` días hábiles después de `desde` (fecha civil o instante). */
export function sumarDiasHabiles(desde: Date | string, n: number, inhabiles: readonly string[] = []): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n debe ser un entero ≥ 0');
  let fecha = typeof desde === 'string' ? desde : fechaLocal(desde);
  let restantes = n;
  while (restantes > 0) {
    fecha = siguiente(fecha);
    if (esDiaHabil(fecha, inhabiles)) restantes--;
  }
  return fecha;
}

/** Días hábiles entre la fecha local de `ahora` (excluida) y `hasta` (incluida); 0 si ya pasó. */
export function diasHabilesHasta(ahora: Date, hasta: string, inhabiles: readonly string[] = []): number {
  let fecha = fechaLocal(ahora);
  let n = 0;
  while (fecha < hasta) {
    fecha = siguiente(fecha);
    if (esDiaHabil(fecha, inhabiles)) n++;
  }
  return n;
}

export interface PlazosArco {
  limiteRespuesta: string;
  limiteEjecucion: string;
}

export function plazosArco(recibidaEn: Date, opts: { inhabiles?: readonly string[] } = {}): PlazosArco {
  const inhabiles = opts.inhabiles ?? [];
  const limiteRespuesta = sumarDiasHabiles(recibidaEn, PLAZO_RESPUESTA_DIAS_HABILES, inhabiles);
  return { limiteRespuesta, limiteEjecucion: sumarDiasHabiles(limiteRespuesta, PLAZO_EJECUCION_DIAS_HABILES, inhabiles) };
}
