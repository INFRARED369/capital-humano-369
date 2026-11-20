/**
 * Hook de resolución de módulos (node:module register) para correr .ts del dominio con Node (type stripping):
 * resuelve los alias @shared/ y @domains/ igual que tsconfig.json y supabase/functions/deno.json.
 * Lo usa scripts/smoke-nightly.mjs.
 */
const RAIZ = new URL('../../', import.meta.url);
const ALIAS = { '@shared/': new URL('src/shared/', RAIZ), '@domains/': new URL('src/domains/', RAIZ) };

export async function resolve(especificador, contexto, siguiente) {
  for (const [prefijo, base] of Object.entries(ALIAS))
    if (especificador.startsWith(prefijo)) return siguiente(new URL(especificador.slice(prefijo.length), base).href, contexto);
  return siguiente(especificador, contexto);
}
