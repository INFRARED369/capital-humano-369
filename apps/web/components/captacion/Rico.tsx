import { Fragment } from 'react';
import { segmentar } from '../../lib/captacion/texto';

/** Texto del contenido JSON con **negrita** y __énfasis__, renderizado como nodos React (sin HTML). */
export function Rico({ texto }: { texto: string }) {
  return (
    <>
      {segmentar(texto).map((s, i) =>
        s.estilo === 'strong' ? <strong key={i}>{s.texto}</strong> : s.estilo === 'b' ? <b key={i}>{s.texto}</b> : <Fragment key={i}>{s.texto}</Fragment>,
      )}
    </>
  );
}

/** Líneas de un título separadas por <br />. */
export function Lineas({ lineas }: { lineas: string[] }) {
  return (
    <>
      {lineas.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          <Rico texto={l} />
        </Fragment>
      ))}
    </>
  );
}
