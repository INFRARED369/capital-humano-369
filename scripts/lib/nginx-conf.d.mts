export interface Directiva {
  nombre: string;
  args: string[];
  bloque?: Directiva[];
}
export interface Header {
  nombre: string;
  valor: string;
  always: boolean;
}
export declare function parsearNginx(texto: string): Directiva[];
export declare function resolverIncludes(directivas: Directiva[], resolver: (ruta: string) => string): Directiva[];
export declare function headersDe(directivas: Directiva[]): Header[];
export declare function bloques(directivas: Directiva[], nombre: string): Directiva[];
export declare function parsearCsp(valor: string): Record<string, string[]>;
