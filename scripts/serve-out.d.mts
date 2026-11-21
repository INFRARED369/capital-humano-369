import type { Server } from 'node:http';
export interface Resolucion {
  estado: number;
  archivo?: string;
  location?: string;
  cache?: string;
}
export declare function headersSeguridad(o?: { confPath?: string; dirOut?: string; cspPath?: string }): Record<string, string>;
export declare function resolverRuta(dir: string, metodo: string, url: string): Resolucion;
export declare function crearServidor(opts: { dir: string; cspPath?: string; headers?: Record<string, string> }): Server;
export declare function usarGzip(acceptEncoding: string | undefined, contentType: string, tamano: number): boolean;
