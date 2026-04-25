import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entry — CatchServer programmatic API
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: true,
    sourcemap: false,
    clean: true,
    minify: true,
    target: 'node18',
    platform: 'node',
    outDir: 'dist',
  },
  // CLI entry — `npx @mailts/trap` / `mailts-trap` binary
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    minify: true,
    target: 'node18',
    platform: 'node',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
