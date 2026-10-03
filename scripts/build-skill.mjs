#!/usr/bin/env node
/**
 * Generates the agent skill's reference files (packages/cli/skill/mailts/references/*.md)
 * from README.md, so the skill never drifts from the documented API.
 * SKILL.md itself is hand-written. Run after editing README.md:
 *
 *   npm run skill:build          # write
 *   npm run skill:build -- --check   # exit 1 if the references are out of date (CI)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'packages/cli/skill/mailts/references');
const REPO = 'https://github.com/anishhs-gh/mailts/blob/master';

/** Top-level README sections (`## …`), keyed by title. Code fences are respected. */
function sections(md) {
  const map = new Map();
  let title = null, buf = [], fence = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    if (!fence && line.startsWith('## ')) {
      if (title) map.set(title, buf.join('\n'));
      title = line.slice(3).trim(); buf = [];
      continue;
    }
    if (title) buf.push(line);
  }
  if (title) map.set(title, buf.join('\n'));
  return map;
}

/** Make links work outside the repo: relative files → GitHub, in-page anchors → README. */
function absolutize(md) {
  return md
    .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, p) => `](${REPO}/${p.replace(/^\.\//, '')})`)
    .replace(/\]\(#([^)]+)\)/g, (_, a) => `](${REPO}/README.md#${a})`);
}

function clean(body) {
  return body.replace(/\n-{3,}\s*$/, '').trim();
}

const FILES = {
  'sending.md': {
    title: 'Sending mail with mailts',
    intro: 'Message options, attachments, calendar invites, replies, unsubscribe headers, smart inbox content, OTP and BIMI, DKIM, HTTP transports, SMTP pooling and proxies.',
    sections: ['Sending mail', 'HTTP transports', 'DKIM signing', 'Connections & pool', 'Proxy support'],
  },
  'reading.md': {
    title: 'Reading mail with mailts',
    intro: 'IMAP sessions, fetch modes, search, flags, drafts, watching for new mail, the connection pool, MIME parsing, and the provider-neutral Mailbox API for IMAP, Gmail and Microsoft Graph.',
    sections: ['IMAP', 'One mailbox API: IMAP, Microsoft Graph, Gmail API'],
  },
  'oauth.md': {
    title: 'OAuth with mailts',
    intro: 'Google and Microsoft sign-in, token providers and refresh-token rotation, scopes, service accounts and app-only access (`@mailts/core/oauth`).',
    sections: ['OAuth (Google & Microsoft)'],
  },
  'queue.md': {
    title: 'Queues with mailts',
    intro: 'The built-in queue (priorities, retries, scheduling, rate limits, idempotency, persistence, shutdown) and MailWorker with external drivers such as Redis or Postgres.',
    sections: ['Queue', 'MailWorker — external queue + lifecycle control'],
  },
  'production.md': {
    title: 'Running mailts in production',
    intro: 'Configuration, security, errors, health checks, telemetry, logs, middleware, templates, dev mode, stability guarantees, examples, and the trap / testing / CLI packages.',
    sections: ['Configuration', 'Security for untrusted input', 'Errors', 'Health checks', 'Telemetry hooks',
      'Streaming logs', 'Middleware', 'Aliases & templates', 'Dev mode', 'Stability & versioning', 'Examples', 'Ecosystem'],
  },
};

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const all = sections(readme);
const check = process.argv.includes('--check');
let stale = 0;

if (!check) mkdirSync(outDir, { recursive: true });
for (const [file, spec] of Object.entries(FILES)) {
  const parts = spec.sections.map((t) => {
    const body = all.get(t);
    if (body === undefined) throw new Error(`README section not found: "${t}" (needed by ${file})`);
    return `## ${t}\n\n${clean(body)}`;
  });
  const out = absolutize(
    `<!-- Generated from README.md by scripts/build-skill.mjs — do not edit by hand. -->\n\n` +
    `# ${spec.title}\n\n${spec.intro}\n\n${parts.join('\n\n')}\n`,
  );
  const path = join(outDir, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== out) { console.error(`out of date: ${path}`); stale++; }
  } else {
    writeFileSync(path, out);
    console.log(`wrote ${file} (${out.length} bytes)`);
  }
}
if (check && stale) { console.error('Run `npm run skill:build` and commit the result.'); process.exit(1); }
if (check) console.log('skill references are up to date');
