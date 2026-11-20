export interface OpcionesIndice {
  dirVacantes: string;
  archivoIndice: string;
}
export declare const DIR_VACANTES: string;
export declare const ARCHIVO_INDICE: string;
export declare function generarIndice(opts: OpcionesIndice): string;
export declare function verificarIndice(opts: OpcionesIndice): { ok: boolean; faltantes: string[] };
