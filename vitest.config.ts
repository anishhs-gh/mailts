import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/types/**', 'src/**/index.ts'],
      thresholds: { branches: 85, functions: 90, lines: 90, statements: 90 },
    },
    testTimeout: 15_000,
  },
  resolve: {
    conditions: ['node'],
  },
});
