import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'smtp/index': 'src/smtp/index.ts',
      'imap/index': 'src/imap/index.ts',
      'queue/index': 'src/queue/index.ts',
      'logger/index': 'src/logger/index.ts',
      'transports/index': 'src/transports/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    target: 'node18',
    platform: 'node',
    outDir: 'dist',
    minify: true,
  },
]);
