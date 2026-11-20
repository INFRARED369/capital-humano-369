import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'apps/web/out', 'apps/web/.next', 'coverage', 'playwright-report', 'test-results', 'legacy/**', 'apps/web/public/**', 'apps/web/next-env.d.ts', 'script.js', 'tracking.js', 'tracking-config.js', 'vacantes/**', '.dependency-cruiser.cjs', '.lighthouseci/**', 'supabase/.temp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Deno: 'readonly', window: 'readonly', document: 'readonly', fetch: 'readonly', crypto: 'readonly', URL: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', TextEncoder: 'readonly', navigator: 'readonly', localStorage: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // NFR-SEG-08: prohibido innerHTML / dangerouslySetInnerHTML
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='innerHTML']", message: 'NFR-SEG-08: prohibido innerHTML.' },
        { selector: "MemberExpression[property.name='outerHTML']", message: 'NFR-SEG-08: prohibido outerHTML.' },
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'NFR-SEG-08: prohibido dangerouslySetInnerHTML.' },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'NFR-SEG-08: prohibido insertAdjacentHTML.' },
      ],
    },
  },
  {
    // Scripts de k6 (perf/k6): globals del runtime de k6.
    files: ['perf/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },
  {
    // R8 / NFR-SEG-04: los dominios no usan console directamente; usan el logger con redacción.
    files: ['src/domains/**/*.ts', 'supabase/functions/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-console': 'error' },
  },
);
