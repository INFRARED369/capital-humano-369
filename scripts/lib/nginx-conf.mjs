/**
 * Parser mínimo de configuración de Nginx (sin dependencias) para:
 *  - verificar los headers de seguridad en pruebas (E2E-14 local, NFR-SEG-07), y
 *  - que scripts/serve-out.mjs sirva `out/` con los MISMOS headers que producción.
 * Soporta directivas, bloques, comillas simples/dobles, escapes y comentarios.
 */

/** @returns {Array<string | symbol>} */
function tokenizar(texto) {
  const tokens = [];
  let i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < texto.length && texto[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}' || c === ';') { tokens.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < texto.length && texto[i] !== c) {
        if (texto[i] === '\\' && i + 1 < texto.length) { s += texto[i + 1]; i += 2; continue; }
        s += texto[i++];
      }
      if (i >= texto.length) throw new Error('nginx: comilla sin cerrar');
      i++;
      tokens.push({ t: 'palabra', v: s });
      continue;
    }
    let s = '';
    while (i < texto.length && !/[\s{};]/.test(texto[i])) s += texto[i++];
    tokens.push({ t: 'palabra', v: s });
  }
  return tokens;
}

/**
 * @typedef {{ nombre: string; args: string[]; bloque?: Directiva[] }} Directiva
 * @returns {Directiva[]}
 */
export function parsearNginx(texto) {
  const tokens = tokenizar(texto);
  let pos = 0;
  function bloque(anidado) {
    const out = [];
    while (pos < tokens.length) {
      const tk = tokens[pos];
      if (tk.t === '}') {
        if (!anidado) throw new Error('nginx: "}" sin abrir');
        pos++;
        return out;
      }
      if (tk.t !== 'palabra') throw new Error(`nginx: token inesperado ${tk.t}`);
      const nombre = tk.v;
      const args = [];
      pos++;
      while (pos < tokens.length && tokens[pos].t === 'palabra') args.push(tokens[pos++].v);
      const fin = tokens[pos];
      if (!fin) throw new Error(`nginx: directiva ${nombre} sin terminar`);
      pos++;
      if (fin.t === ';') out.push({ nombre, args });
      else if (fin.t === '{') out.push({ nombre, args, bloque: bloque(true) });
      else throw new Error(`nginx: se esperaba ; o { tras ${nombre}`);
    }
    if (anidado) throw new Error('nginx: falta "}"');
    return out;
  }
  return bloque(false);
}

/** Sustituye `include` por las directivas del archivo (resolver: ruta → texto). */
export function resolverIncludes(directivas, resolver) {
  return directivas.flatMap((d) => {
    if (d.nombre === 'include') return resolverIncludes(parsearNginx(resolver(d.args[0])), resolver);
    return d.bloque ? [{ ...d, bloque: resolverIncludes(d.bloque, resolver) }] : [d];
  });
}

/** Headers declarados con add_header en este nivel (sin herencia). Nombres en minúsculas. */
export function headersDe(directivas) {
  return directivas
    .filter((d) => d.nombre === 'add_header')
    .map((d) => ({ nombre: d.args[0].toLowerCase(), valor: d.args[1] ?? '', always: d.args[2] === 'always' }));
}

/** Busca recursivamente bloques por nombre (p. ej. 'server', 'location'). */
export function bloques(directivas, nombre) {
  const out = [];
  for (const d of directivas) {
    if (d.nombre === nombre) out.push(d);
    if (d.bloque) out.push(...bloques(d.bloque, nombre));
  }
  return out;
}

/** Parsea una CSP en { directiva: [fuentes] }. */
export function parsearCsp(valor) {
  return Object.fromEntries(
    valor.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [k, ...v] = s.split(/\s+/);
      return [k.toLowerCase(), v];
    }),
  );
}
