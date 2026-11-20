/** Zod 4 sin JIT (`new Function`) en el navegador: compatible con script-src sin 'unsafe-eval'. */
interface ConZod { __zod_globalConfig?: Record<string, unknown> }

export function configurarZodSinEval(g: ConZod = globalThis as ConZod): void {
  // Mutar en sitio: si Zod ya cargó, conserva la referencia a este mismo objeto.
  Object.assign((g.__zod_globalConfig ??= {}), { jitless: true });
}
