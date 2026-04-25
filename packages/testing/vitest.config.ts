import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
export default defineConfig({
  resolve: {
    alias: {
      '@mailts/trap': resolve(__dirname, '../trap/src/index.ts'),
    },
  },
  test: { include: ['tests/**/*.test.ts'], globals: true },
});
