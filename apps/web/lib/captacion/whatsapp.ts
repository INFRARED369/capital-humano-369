/** Respaldo por WhatsApp (CAP-10, NFR-DISP-01): el candidato envía él mismo lo que ya capturó. */
export function linkWhatsApp(numero: string, texto: string): string {
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

export function mensajeFallback(d: { vacante: string; nombre: string; folio: string | null; horario: string | null; respuestas: Array<[string, string]> }): string {
  return [
    `Hola Capital Humano 369, quiero postularme a la vacante ${d.vacante}.`,
    d.nombre ? `Nombre: ${d.nombre}` : null,
    d.folio ? `Folio: ${d.folio}` : null,
    d.horario ? `Horario que elegí para entrevista: ${d.horario}` : null,
    ...d.respuestas.map(([p, r]) => `${p}: ${r}`),
  ].filter(Boolean).join('\n');
}

/** Referencia corta y sin PII para correlacionar el chat con el ClickCTA (mismo event_id en Pixel/CAPI). */
export function referenciaDe(eventId: string): string {
  return `WA-${eventId.replace(/-/g, '').slice(-6).toUpperCase()}`;
}

/**
 * F7.4 · Vacante con `agenda_modo = 'whatsapp'`: el candidato agenda por chat. Solo viaja lo necesario para
 * iniciar la conversación (vacante, nombre de pila y referencia): ni apellidos, ni teléfono (el chat ya lo trae),
 * ni correo, ni respuestas del perfil.
 */
export function mensajeAgendaWhatsApp(d: { vacante: string; nombre: string; referencia: string }): string {
  const pila = d.nombre.trim().split(/\s+/)[0] ?? '';
  return [
    `Hola Capital Humano 369, quiero agendar mi entrevista para la vacante ${d.vacante}.`,
    pila ? `Mi nombre: ${pila}` : null,
    `Referencia: ${d.referencia}`,
  ].filter(Boolean).join('\n');
}

export function linkAgendaWhatsApp(numero: string, d: { vacante: string; nombre: string; eventId: string }): string {
  return linkWhatsApp(numero, mensajeAgendaWhatsApp({ vacante: d.vacante, nombre: d.nombre, referencia: referenciaDe(d.eventId) }));
}
