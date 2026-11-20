export declare function parsearWorkflow(texto: string): Record<string, unknown>;
export declare function validarWorkflow(nombre: string, wf: unknown): string[];
export declare function validarPipelineDeploy(nombre: string, wf: unknown): string[];
export declare const PROYECTOS_E2E: string[];
export declare function specsNoCubiertos(wf: unknown, specs: string[], proyectos?: string[]): string[];
export declare function validarNightly(nombre: string, wf: unknown): string[];
export declare function validarDirectorio(dir: string, dirE2e?: string): string[];
