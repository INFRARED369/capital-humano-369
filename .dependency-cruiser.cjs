/** Fronteras del monolito modular (NFR-MANT-01). */
module.exports = {
  forbidden: [
    {
      name: 'dominio-no-importa-internos-de-otro-dominio',
      comment: 'Un dominio solo puede usar la API pública (index.ts) de otro dominio.',
      severity: 'error',
      from: { path: '^src/domains/([^/]+)/' },
      to: { path: '^src/domains/([^/]+)/(?!index\\.ts$)', pathNot: '^src/domains/$1/' },
    },
    {
      name: 'capa-domain-es-pura',
      comment: 'domain/ no depende de application/, infra/ ni ui/.',
      severity: 'error',
      from: { path: '^src/domains/[^/]+/domain/' },
      to: { path: '^src/domains/[^/]+/(application|infra|ui)/' },
    },
    {
      name: 'application-no-depende-de-infra',
      comment: 'application/ depende de puertos, no de adaptadores concretos.',
      severity: 'error',
      from: { path: '^src/domains/[^/]+/application/' },
      to: { path: '^src/domains/[^/]+/(infra|ui)/' },
    },
    {
      name: 'shared-no-depende-de-dominios',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/domains/' },
    },
    {
      name: 'web-solo-usa-api-publica',
      comment: 'La app web solo importa el index.ts o ui/ de cada dominio.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^src/domains/[^/]+/(?!index\\.ts$|ui/)' },
    },
    {
      name: 'dominios-no-dependen-de-funciones',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^supabase/functions/' },
    },
    { name: 'sin-ciclos', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.test\\.ts$|node_modules)' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
