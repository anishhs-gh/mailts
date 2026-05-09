#!/usr/bin/env node
import('./dist/index.js').catch(err => {
  if (
    err instanceof SyntaxError &&
    typeof err.message === 'string' &&
    err.message.includes("'@mailts/core'") &&
    err.message.includes('does not provide an export named')
  ) {
    const name = err.message.match(/export named '([^']+)'/)?.[1] ?? 'unknown';
    process.stderr.write(
      `Error: @mailts/core is outdated — missing export '${name}'.\n` +
      `Fix options:\n\n` +
      `  npx --yes @mailts/cli@latest <command>   (one-off, no install)\n` +
      `  npm install -g @mailts/cli               (install globally)\n`,
    );
    process.exit(1);
  }
  throw err;
});
