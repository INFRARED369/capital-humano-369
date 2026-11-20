'use client';
/** Piezas comunes del panel: carga asíncrona, lectura de la URL y estados accesibles. */
import { useCallback, useEffect, useState, type DependencyList, type ReactNode } from 'react';

export type Carga<T> = { estado: 'cargando' } | { estado: 'ok'; datos: T } | { estado: 'error'; mensaje: string };

export function useDatos<T>(fn: () => Promise<T>, deps: DependencyList): Carga<T> & { recargar: () => void } {
  const [carga, setCarga] = useState<Carga<T>>({ estado: 'cargando' });
  const [n, setN] = useState(0);
  // Las dependencias las define quien llama (como en useEffect).
  const ejecutar = useCallback(fn, deps);
  useEffect(() => {
    let vivo = true;
    // Revalidación sin desmontar: si ya hay datos, se muestran hasta que llegan los nuevos.
    setCarga((previa) => (previa.estado === 'ok' ? previa : { estado: 'cargando' }));
    ejecutar().then(
      (datos) => vivo && setCarga({ estado: 'ok', datos }),
      () => vivo && setCarga({ estado: 'error', mensaje: 'No se pudieron cargar los datos. Intenta de nuevo.' }),
    );
    return () => {
      vivo = false;
    };
  }, [ejecutar, n]);
  return { ...carga, recargar: () => setN((x) => x + 1) };
}

/** Lee la URL solo en el navegador (export estático: no hay searchParams en el servidor). */
export function useUbicacion(): { search: string; hash: string; pathname: string } | null {
  const [loc, setLoc] = useState<{ search: string; hash: string; pathname: string } | null>(null);
  useEffect(() => {
    const leer = () => setLoc({ search: window.location.search, hash: window.location.hash, pathname: window.location.pathname });
    leer();
    window.addEventListener('hashchange', leer);
    return () => window.removeEventListener('hashchange', leer);
  }, []);
  return loc;
}

export function EstadoCarga<T>({ carga, children }: { carga: Carga<T>; children: (datos: T) => ReactNode }) {
  if (carga.estado === 'cargando') return <p className="p-cargando" role="status">Cargando…</p>;
  if (carga.estado === 'error') return <p className="p-error" role="alert">{carga.mensaje}</p>;
  return <>{children(carga.datos)}</>;
}
