/**
 * Diff de reglas (S4, NFR-SEG-09). Mismo formato que `config.diff_jsonb` en SQL, que es la fuente
 * que se audita; este se usa en el editor para mostrar los cambios pendientes antes de guardar.
 * Recorre objetos; los arreglos y escalares son hojas; lo ausente vale null; un objeto ausente vale {}.
 */
export interface Cambio { ruta: string; antes: unknown; despues: unknown }

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Igualdad estructural de JSON (las llaves de un objeto no tienen orden). */
function igual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => igual(x, b[i]));
  if (esObjeto(a) && esObjeto(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && igual(a[k], b[k]));
  }
  return false;
}

function recorrer(a: unknown, b: unknown, ruta: string, out: Cambio[]): void {
  const oa = a === undefined || a === null ? (esObjeto(b) ? {} : null) : a;
  const ob = b === undefined || b === null ? (esObjeto(a) ? {} : null) : b;
  if (esObjeto(oa) && esObjeto(ob)) {
    // Orden por punto de código (= collate "C" del SQL para llaves ASCII).
    const llaves = [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (const k of llaves) recorrer(oa[k], ob[k], ruta ? `${ruta}.${k}` : k, out);
    return;
  }
  const va = (a ?? null) as Json;
  const vb = (b ?? null) as Json;
  if (!igual(va, vb)) out.push({ ruta, antes: va, despues: vb });
}

export function diffReglas(antes: unknown, despues: unknown): Cambio[] {
  const out: Cambio[] = [];
  recorrer(antes, despues, '', out);
  return out;
}
