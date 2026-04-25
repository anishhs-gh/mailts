import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: true,
  target: 'node18',
  platform: 'node',
  outDir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
  external: ['readline/promises'],
});
