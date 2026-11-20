import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@domains': fileURLToPath(new URL('./src/domains', import.meta.url)),
  '@web': fileURLToPath(new URL('./apps/web', import.meta.url)),
  '@test': fileURLToPath(new URL('./test', import.meta.url)),
};

// Convención de archivos de prueba:
//   *.test.ts      → unitarias (dominio puro, sin BD ni red)
//   *.int.test.ts  → integración (casos de uso + PGlite + MSW)
//   *.db.test.ts   → BD/seguridad (RLS, locks, retención) — sustituto de pgTAP con PGlite
export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/domains/**/domain/**/*.ts', 'src/domains/**/application/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        'src/domains/**/domain/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/domains/**/application/**': { lines: 80, functions: 80, branches: 75, statements: 80 },
      },
    },
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['src/**/*.test.ts', 'apps/web/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts', 'scripts/**/*.test.ts', 'infra/**/*.test.ts'], exclude: ['**/*.int.test.ts', '**/*.db.test.ts', '**/node_modules/**'], environment: 'node' },
      },
      {
        resolve: { alias },
        test: { name: 'integration', include: ['**/*.int.test.ts'], exclude: ['**/node_modules/**'], testTimeout: 30000, hookTimeout: 120000 },
      },
      {
        resolve: { alias },
        test: { name: 'db', include: ['**/*.db.test.ts'], exclude: ['**/node_modules/**'], testTimeout: 30000, hookTimeout: 120000 },
      },
    ],
  },
});
