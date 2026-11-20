/**
 * Decisión de reconciliación (CIT-09, Z5) como función pura: el SISTEMA GANA.
 * Entrada: lo que el sistema espera tener publicado en UN calendario y lo que hay en Zoho
 * para el mismo rango. Salida: acciones a ejecutar (cada una implica una alerta ZOHO_DRIFT,
 * salvo `adoptar`, que solo recupera un uid no guardado).
 */
import { difiereDelEsperado, type CampoDrift, type EventoCalendario } from './evento.ts';
import type { EventoRemoto } from './tipos.ts';

export interface EsperadoZoho {
  citaId: string;
  zohoEventUid: string | null;
  evento: EventoCalendario;
}

export type AccionReconciliacion =
  | { tipo: 'recrear'; citaId: string; motivo: 'borrado_en_zoho' | 'no_publicado' }
  | { tipo: 'adoptar'; citaId: string; zohoEventUid: string }
  | { tipo: 'corregir'; citaId: string; zohoEventUid: string; etag: string; campos: CampoDrift[] }
  | { tipo: 'borrar'; zohoEventUid: string; etag: string; uidPropio: string };

export function decidirReconciliacion(esperados: readonly EsperadoZoho[], remotos: readonly EventoRemoto[]): AccionReconciliacion[] {
  const acciones: AccionReconciliacion[] = [];
  const usados = new Set<string>();
  const porUid = new Map(remotos.map((r) => [r.uid, r]));

  for (const e of esperados) {
    const remoto =
      (e.zohoEventUid ? porUid.get(e.zohoEventUid) : undefined) ??
      remotos.find((r) => !usados.has(r.uid) && r.uidPropio === e.evento.uidPropio);

    if (!remoto) {
      acciones.push({ tipo: 'recrear', citaId: e.citaId, motivo: e.zohoEventUid ? 'borrado_en_zoho' : 'no_publicado' });
      continue;
    }
    usados.add(remoto.uid);
    if (remoto.uid !== e.zohoEventUid) acciones.push({ tipo: 'adoptar', citaId: e.citaId, zohoEventUid: remoto.uid });
    const campos = difiereDelEsperado(e.evento, remoto);
    if (campos.length > 0) acciones.push({ tipo: 'corregir', citaId: e.citaId, zohoEventUid: remoto.uid, etag: remoto.etag, campos });
  }

  // Eventos nuestros (con marcador) que no corresponden a ninguna cita vigente, o duplicados.
  for (const r of remotos) {
    if (r.uidPropio && !usados.has(r.uid)) acciones.push({ tipo: 'borrar', zohoEventUid: r.uid, etag: r.etag, uidPropio: r.uidPropio });
  }
  return acciones;
}
