export interface Hallazgo {
  regla: string;
  descripcion: string;
  archivo: string;
  linea: number;
  muestra: string;
}
export declare const REGLAS: ReadonlyArray<{ id: string; descripcion: string; re: RegExp; esSecreto?: (m: string) => boolean }>;
export declare function escanearTexto(texto: string, archivo: string): Hallazgo[];
export declare function escanearDirectorio(dir: string): Promise<Hallazgo[]>;
