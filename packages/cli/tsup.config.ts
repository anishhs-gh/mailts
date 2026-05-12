import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

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
  define: {
    // Replaced at build time — no need to touch src/index.ts when bumping the version
    __CLI_VERSION__: JSON.stringify(version),
  },
});
