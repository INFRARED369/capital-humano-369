/**
 * Corre ANTES del código de la app en el navegador (Next.js `instrumentation-client`).
 * NFR-SEG-07 (CSP sin 'unsafe-eval'): Zod 4 sondea `new Function("")` al construir cada `z.object` para
 * su JIT; con nuestra CSP el sondeo falla en silencio pero el navegador lo reporta como
 * `securitypolicyviolation`. `jitless` evita el sondeo (Zod lee globalThis.__zod_globalConfig al cargar),
 * sin cambiar la validación. Probado por e2e (fixture que falla ante cualquier violación de CSP).
 */
import { configurarZodSinEval } from './lib/zod-sin-eval';

configurarZodSinEval();
