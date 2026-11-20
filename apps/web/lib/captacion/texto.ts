/** Marcado mínimo del contenido JSON: **negrita** → <strong>, __énfasis__ → <b>. Nunca HTML (NFR-SEG-08). */
export interface Segmento {
  texto: string;
  estilo: 'normal' | 'strong' | 'b';
}

const RE = /\*\*(.+?)\*\*|__(.+?)__/g;

export function segmentar(texto: string): Segmento[] {
  const out: Segmento[] = [];
  let ultimo = 0;
  for (const m of texto.matchAll(RE)) {
    if (m.index > ultimo) out.push({ texto: texto.slice(ultimo, m.index), estilo: 'normal' });
    out.push(m[1] !== undefined ? { texto: m[1], estilo: 'strong' } : { texto: m[2]!, estilo: 'b' });
    ultimo = m.index + m[0].length;
  }
  if (ultimo < texto.length) out.push({ texto: texto.slice(ultimo), estilo: 'normal' });
  return out;
}
