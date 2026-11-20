export declare const MARCADOR: string;
export declare const RUTAS_DEFECTO: { out: string; plantilla: string; destino: string };
export declare function scriptsInline(html: string): string[];
export declare function hashSha256(contenido: string): string;
export declare function recolectarHashes(dirOut: string): { archivos: number; scripts: string[] };
export declare function renderizarCsp(plantilla: string, hashes: string[]): string;
export declare function hashesDeConf(texto: string): string[];
export declare function generarCspConf(o: { dirOut: string; plantilla: string; unirCon?: string }): { conf: string; hashes: string[]; archivos: number };
