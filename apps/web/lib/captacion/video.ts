/** Hitos del video de la vacante: cada evento del funnel se emite una sola vez por carga. */
export type EventoVideo = 'VideoPlay' | 'VideoProgress50' | 'VideoComplete';
export interface HitosVideo { play: boolean; mitad: boolean; fin: boolean }
export const HITOS_VACIOS: HitosVideo = { play: false, mitad: false, fin: false };

export function hitosVideo(estado: HitosVideo, v: { reproduciendo: boolean; actual: number; duracion: number; terminado: boolean }): { estado: HitosVideo; eventos: EventoVideo[] } {
  const e = { ...estado };
  const eventos: EventoVideo[] = [];
  if (!e.play && v.reproduciendo) { e.play = true; eventos.push('VideoPlay'); }
  if (!e.mitad && v.duracion > 0 && v.actual / v.duracion >= 0.5 && !v.terminado) { e.mitad = true; eventos.push('VideoProgress50'); }
  if (!e.fin && v.terminado) { e.fin = true; eventos.push('VideoComplete'); }
  return { estado: e, eventos };
}
