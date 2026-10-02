/**
 * Upserts one GitHub Gist per file in examples/.
 * Each gist contains the example .ts file + a rendered README.md.
 * Rewrites local ../src/... imports to npm package references.
 * Matches existing gists by description; creates if not found.
 *
 * Requires: GIST_TOKEN env var (PAT with `gist` scope)
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TOKEN = process.env.GIST_TOKEN;
if (!TOKEN) { console.error('GIST_TOKEN not set'); process.exit(1); }

const EXAMPLES_DIR = new URL('../examples', import.meta.url).pathname;
const REPO = 'https://github.com/anishhs-gh/mailts';
const NPM  = 'https://www.npmjs.com/package/@mailts/core';

// ── Per-file metadata ────────────────────────────────────────────────────────

const META = {
  'basic-send.ts': {
    description: '@mailts/core — Basic SMTP email send (text + HTML) | typescript email smtp',
    title:       'Basic SMTP email send',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<app-password> npx tsx basic-send.ts',
    features:    ['Plain-text + HTML multipart email', 'One-shot connection (pool: false)', 'Logger stream to stdout', 'Discriminated SendResult (ok / error)'],
  },
  'imap-read.ts': {
    description: '@mailts/core — IMAP: list mailboxes, fetch unread messages, IDLE push | typescript email imap',
    title:       'IMAP: fetch unread messages and IDLE push',
    install:     'npm install @mailts/core',
    run:         'IMAP_USER=you@gmail.com IMAP_PASS=<app-password> npx tsx imap-read.ts',
    features:    ['List mailboxes with special-use roles', 'Unseen count via open()', 'Full bodies without marking mail read', 'watch() — new mail by UID, auto-reconnect'],
  },
  'transports.ts': {
    description: '@mailts/core — Pluggable transports: Resend, SendGrid, Postmark, Mailgun, AWS SES | typescript email smtp',
    title:       'Pluggable transports: Resend, SendGrid, Postmark, Mailgun, AWS SES',
    install:     'npm install @mailts/core',
    run:         'RESEND_API_KEY=re_... npx tsx transports.ts',
    features:    ['ResendTransport', 'SendGridTransport', 'PostmarkTransport', 'MailgunTransport (EU region support)', 'SesTransport (SigV4 auth)', 'Custom Transport interface'],
  },
  'dkim-and-proxy.ts': {
    description: '@mailts/core — DKIM signing + SOCKS5 / HTTP proxy routing | typescript email dkim deliverability',
    title:       'DKIM signing + SOCKS5 / HTTP proxy',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<pass> npx tsx dkim-and-proxy.ts',
    features:    ['DKIM rsa-sha256 signing (relaxed/relaxed)', 'Custom header field signing coverage', 'SOCKS5 proxy with optional auth', 'HTTP CONNECT proxy tunnel'],
  },
  'queue-and-dlq.ts': {
    description: '@mailts/core — Send queue with retries, exponential backoff, and Dead-Letter Queue | typescript email queue',
    title:       'Send queue with retries, backoff, and Dead-Letter Queue (DLQ)',
    install:     'npm install @mailts/core',
    run:         'npx tsx queue-and-dlq.ts',
    features:    ['Concurrent queue processing', 'Exponential backoff with jitter', 'Per-job timeout', 'Dead-Letter Queue for exhausted jobs', 'Queue events: success, retry, dead', 'Queue stats'],
  },
  'middleware-and-devmode.ts': {
    description: '@mailts/core — Middleware pipeline and devMode (intercept without sending) | typescript email middleware',
    title:       'Middleware pipeline and devMode',
    install:     'npm install @mailts/core',
    run:         'npx tsx middleware-and-devmode.ts',
    features:    ['Ordered middleware pipeline', 'Header injection middleware', 'Dev-inbox redirect in non-prod', 'External domain block in staging', 'Send latency measurement', 'devMode: log without transmitting', 'Runtime reconfigure via configure()'],
  },
  'aliases-and-templates.ts': {
    description: '@mailts/core — Aliases, custom template engine ({{var}} syntax), middleware | typescript email template',
    title:       'Aliases, template engine, and middleware',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<pass> npx tsx aliases-and-templates.ts',
    features:    ['Custom template engine ({{var}} with dot-path)', 'Reusable alias definitions (define)', 'Trigger aliases with runtime data overrides', 'Per-message middleware headers'],
  },
  'attachments-and-inline.ts': {
    description: '@mailts/core — Attachments, inline images (CID embedding), RFC 822 forwarding | typescript email attachments',
    title:       'Attachments, inline images (CID), and RFC 822 forwarding',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<pass> npx tsx attachments-and-inline.ts',
    features:    ['Buffer + file path attachments', 'Inline image embedding via Content-ID (CID)', 'RFC 822 message/rfc822 forwarding part', 'Auto content-type detection from filename'],
  },
  'ical-invite.ts': {
    description: '@mailts/core — Calendar invites and cancellations via iCal / ICS | typescript email ical calendar',
    title:       'Calendar invites and cancellations (iCal / ICS)',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<pass> npx tsx ical-invite.ts',
    features:    ['text/calendar MIME part (ICS attachment)', 'Invite with attendees, organizer, location', 'System timezone auto-detection', 'Cancellation (CANCEL method, same UID)'],
  },
  'streaming-logs.ts': {
    description: '@mailts/core — Streaming logs: event listener, JSON file, SMTP protocol trace | typescript email logging',
    title:       'Streaming logs: events, JSON file, SMTP protocol trace',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<pass> npx tsx streaming-logs.ts',
    features:    ['onEvent() listener for targeted log levels', 'JSON log stream piped to file', 'Pretty protocol trace to stdout', 'Credential auto-redaction in protocol logs'],
  },
  'cc-bcc-replyto.ts': {
    description: '@mailts/core — CC, BCC, Reply-To, priority, and send helpers (notify/alert/sendTemplate) | typescript email smtp',
    title:       'CC, BCC, Reply-To, priority, and send helpers',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<pass> npx tsx cc-bcc-replyto.ts',
    features:    ['CC and BCC recipients (envelope-only BCC)', 'Reply-To override', 'X-Priority / Importance headers', 'notify() — auto [NOTIFICATION] prefix', 'alert() — auto [ALERT] prefix + high priority', 'sendTemplate() — inline template rendering'],
  },
  'xoauth2.ts': {
    description: '@mailts/core — OAuth2 / XOAUTH2 for Gmail SMTP and IMAP (no app password) | typescript email oauth2 gmail',
    title:       'OAuth2 / XOAUTH2 for Gmail SMTP and IMAP',
    install:     'npm install @mailts/core',
    run:         'MAIL_USER=you@gmail.com GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=… npx tsx xoauth2.ts',
    features:    ['XOAUTH2 for SMTP and IMAP', 'getToken provider — automatic refresh', 'mailConfigFor(google) presets', 'Works with Google Workspace + personal Gmail'],
  },
  'oauth-cli.ts': {
    description: '@mailts/core — OAuth sign-in for CLIs: Gmail & Microsoft 365 via browser, PKCE, refresh | typescript email oauth2 gmail outlook',
    title:       'OAuth for CLIs — Google & Microsoft sign-in, send, sign out',
    install:     'npm install @mailts/core',
    run:         'PROVIDER=google MAIL_USER=you@gmail.com GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npx tsx oauth-cli.ts signin',
    features:    ['authorizeWithLoopback() — browser sign-in with PKCE', 'Refresh-token storage and rotation', 'createTokenProvider() for SMTP/IMAP', 'Sign out with token revocation'],
  },
  'oauth-web-server.ts': {
    description: '@mailts/core — "Connect your mailbox" web flow for Gmail & Microsoft 365 | typescript email oauth2 web',
    title:       'OAuth web flow — connect Gmail / Microsoft 365 mailboxes',
    install:     'npm install @mailts/core',
    run:         'GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… MS_CLIENT_ID=… MS_CLIENT_SECRET=… npx tsx oauth-web-server.ts',
    features:    ['buildAuthorizationUrl() + PKCE + state', 'exchangeCode() in the callback', 'Per-mailbox token providers', 'Works in any Node HTTP framework'],
  },
  'reply-and-save-to-sent.ts': {
    description: '@mailts/core — reply in-thread, save to Sent, save drafts over IMAP | typescript email imap smtp',
    title:       'Reply in-thread and save to Sent / Drafts',
    install:     'npm install @mailts/core',
    run:         'MAIL_USER=… MAIL_PASS=… IMAP_HOST=… SMTP_HOST=… npx tsx reply-and-save-to-sent.ts',
    features:    ['inReplyTo / references threading', 'send(opts, { saveToSent: true })', 'findMailbox(\'\\\\Drafts\')', 'appendMessage() drafts'],
  },
  'parse-eml.ts': {
    description: '@mailts/core — parse raw email / .eml files: bodies, attachments, headers | typescript email mime parser',
    title:       'Parse raw email (.eml) with parseMessage()',
    install:     'npm install @mailts/core',
    run:         'npx tsx parse-eml.ts [file.eml]',
    features:    ['multipart/alternative/related/mixed', 'RFC 2047 headers, RFC 2231 filenames', 'Inline (cid) and regular attachments', 'Nested forwarded messages'],
  },
  'untrusted-input.ts': {
    description: '@mailts/core — safe sending for AI agents and web forms: attachmentPolicy, injection guards | typescript email security',
    title:       'Sending from untrusted input (AI agents, forms)',
    install:     'npm install @mailts/core',
    run:         'npx tsx untrusted-input.ts',
    features:    ['attachmentPolicy: deny / { root }', 'Header and SMTP injection rejected', 'requireTLS by default', 'Result-based error handling'],
  },
  'queue-persistence.ts': {
    description: '@mailts/core — crash-safe SQLite email queue, exactly-once delivery after restart | typescript email queue sqlite',
    title:       'Crash-safe persistent queue (SQLite)',
    install:     'npm install @mailts/core',
    run:         'npx tsx queue-persistence.ts enqueue && npx tsx queue-persistence.ts deliver',
    features:    ['Jobs survive crashes, delivered once', 'Multi-process leases', 'shutdown() keeps unsent mail', 'Buffer attachments persisted'],
  },
  'oauth-app-only.ts': {
    description: '@mailts/core — organisation-wide mailbox access: Google service account + Microsoft client credentials | typescript email oauth2 workspace',
    title:       'App-only OAuth — Google Workspace / Microsoft 365 without user sign-in',
    install:     'npm install @mailts/core',
    run:         'GOOGLE_SA_KEY=./sa.json MAILBOX=support@company.com npx tsx oauth-app-only.ts google',
    features:    ['Service account domain-wide delegation', 'Microsoft client credentials (secret / certificate)', 'Read and send as a shared mailbox'],
  },
  'mailbox-any-provider.ts': {
    description: '@mailts/core — one mailbox API for IMAP, Microsoft Graph and Gmail API | typescript email imap graph gmail',
    title:       'One Mailbox API for IMAP, Microsoft Graph and Gmail',
    install:     'npm install @mailts/core',
    run:         'PROVIDER=gmail MAIL_USER=… GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=… npx tsx mailbox-any-provider.ts',
    features:    ['Provider-neutral fetch / search / flags / move / drafts', 'watch() for new mail', 'Graph and Gmail API without IMAP'],
  },
  'newsletter-unsubscribe.ts': {
    description: '@mailts/core — bulk email: one-click unsubscribe (RFC 8058), rate limits, idempotency | typescript email newsletter',
    title:       'Newsletter sending: one-click unsubscribe, rate limits, idempotency',
    install:     'npm install @mailts/core',
    run:         'npx tsx newsletter-unsubscribe.ts',
    features:    ['List-Unsubscribe + one-click POST', 'Queue rate limiting', 'Idempotency keys — never email twice'],
  },
  'imap-manage.ts': {
    description: '@mailts/core — IMAP management: flags, copy, move, delete, append, CONDSTORE | typescript email imap',
    title:       'IMAP: flags, copy, move, delete, append, CONDSTORE',
    install:     'npm install @mailts/core',
    run:         'IMAP_PASS=<app-password> npx tsx imap-manage.ts',
    features:    ['getStatus() without selecting mailbox', 'markSeen / markUnseen / markFlagged / markUnflagged', 'setFlags() for arbitrary IMAP flags', 'copy() and move() across mailboxes', 'delete() — mark + expunge', 'append() — save to Sent / Drafts', 'fetchChanged() — CONDSTORE incremental sync', 'Mailbox create / rename / delete'],
  },
  'smtp-pool-config.ts': {
    description: '@mailts/core — SMTP connection pool: tuning, bulk send, testConnection, runtime reconfigure | typescript email smtp performance',
    title:       'SMTP connection pool: tuning, bulk send, testConnection',
    install:     'npm install @mailts/core',
    run:         'SMTP_PASS=<pass> npx tsx smtp-pool-config.ts',
    features:    ['maxConnections / maxMessages / idleTimeout pool tuning', 'connectionTimeout and socketTimeout', 'testConnection() — credential pre-flight check', 'Parallel bulk send via Promise.all', 'configure() — runtime credential/host swap without new instance'],
  },
  'trap-local-dev.ts': {
    description: '@mailts/trap — Local dev mail trap with web UI at localhost:1080 | typescript email testing devtools',
    title:       'Local dev mail trap with web UI',
    install:     'npm install @mailts/core @mailts/trap',
    run:         'npx tsx trap-local-dev.ts',
    features:    ['In-process SMTP trap server', 'Web UI + REST API at localhost:1080', 'Captures all outbound email locally', 'Optional NDJSON persistence across restarts'],
  },
  'trap-testing.test.ts': {
    description: '@mailts/testing — Integration testing with Vitest + in-process trap server | typescript email testing vitest',
    title:       'Integration testing with Vitest + trap server',
    install:     'npm install @mailts/core @mailts/trap @mailts/testing vitest',
    run:         'npx vitest run trap-testing.test.ts',
    features:    ['useTrapServer() — start/stop trap around test suite', 'waitForMessage() — deterministic polling (no arbitrary sleeps)', 'Assert subject, HTML body, attachments', 'Zero external SMTP calls in CI'],
  },
  'health-checks.ts': {
    description: '@mailts/core — Health checks: SMTP + IMAP probe, latency, K8s liveness/readiness | typescript email health',
    title:       'Health checks: SMTP + IMAP probe for K8s liveness/readiness',
    install:     'npm install @mailts/core',
    run:         'SMTP_USER=you@gmail.com SMTP_PASS=<app-password> npx tsx health-checks.ts',
    features:    ['mail.health() — pings SMTP (EHLO + NOOP) and IMAP, measures latency', 'Structured HealthResult (ok, latencyMs, error per service)', 'K8s liveness/readiness HTTP probe example', 'HealthChecker standalone usage (SMTP-only or IMAP-only)', 'Zero extra dependencies — uses existing config'],
  },
  'queue-lifecycle.ts': {
    description: '@mailts/core — Queue lifecycle: priority scheduling, play/pause, cancel, interrupt, abort, shutdown | typescript email queue',
    title:       'Queue lifecycle: priority, pause, cancel, interrupt, abort',
    install:     'npm install @mailts/core',
    run:         'npx tsx queue-lifecycle.ts',
    features:    ['Priority scheduling (critical → high → normal → low)', 'pause() / play() — stop and restart the queue', 'cancel(jobId) — remove permanently, no retry', 'interrupt(jobId) — requeue at front, attempt counter unchanged', 'abort(jobId) — force-fail, retry/DLQ applies', 'shutdown({ pending: drain | keep | cancel }) — never drops mail by default', 'sendAt — scheduled sends'],
  },
  'mail-worker-redis.ts': {
    description: '@mailts/core — MailWorker + Redis: external queue persistence with full lifecycle control | typescript email queue redis',
    title:       'MailWorker + Redis: external persistence, full lifecycle control',
    install:     'npm install @mailts/core ioredis',
    run:         'REDIS_URL=redis://localhost:6379 SMTP_PASS=<pass> npx tsx mail-worker-redis.ts',
    features:    ['QueueDriver interface — dequeue / ack / nack', 'Redis BRPOPLPUSH reliable queue pattern (survives crash)', 'MailWorker bridges external persistence with MailQueue lifecycle', 'pause() — stops pulling from Redis AND stops queue execution', 'resume() — restarts both consumer loop and queue', 'release() — hand unstarted messages back on shutdown', 'encodeOptions / decodeOptions keep attachments intact', 'prefetch backpressure'],
  },
};

// ── Import rewriting ─────────────────────────────────────────────────────────

const LOCAL_IMPORTS = [
  /from '\.\.\/src\/index\.js'/g,
  /from '\.\.\/src\/types\/index\.js'/g,
  /from '\.\.\/src\/types\/core\.js'/g,
  /from '\.\.\/src\/errors\.js'/g,
  /from '\.\.\/src\/transports\/index\.js'/g,
  /from '\.\.\/src\/transports\/Transport\.js'/g,
];

const DYNAMIC_IMPORT = /await import\('\.\.\/src\/errors\.js'\)/g;

function rewriteImports(src) {
  let out = src;
  for (const re of LOCAL_IMPORTS) out = out.replace(re, "from '@mailts/core'");
  out = out.replace(DYNAMIC_IMPORT, "await import('@mailts/core')");
  return out;
}

// ── Install hint injection ───────────────────────────────────────────────────

function injectHeader(src, install) {
  const hint = `// Install:  ${install}\n// Docs:     ${REPO}\n`;
  const jsdocEnd = src.indexOf('*/');
  if (jsdocEnd === -1) return hint + '\n' + src;
  const after = jsdocEnd + 2;
  return src.slice(0, after) + '\n' + hint + src.slice(after);
}

// ── README generation ────────────────────────────────────────────────────────

function buildReadme(filename, meta) {
  const pkg = filename.startsWith('trap-testing') ? '@mailts/testing'
    : filename.startsWith('trap-') ? '@mailts/trap'
    : '@mailts/core';

  const featureList = meta.features.map(f => `- ${f}`).join('\n');

  return `# \`${filename}\`
> ${meta.title}

## Install
\`\`\`sh
${meta.install}
\`\`\`

## Run
\`\`\`sh
${meta.run}
\`\`\`

## What this covers
${featureList}

---

Part of the [\`${pkg}\`](${NPM}) examples.
Source: [github.com/anishhs-gh/mailts](${REPO})
`;
}

// ── GitHub Gist API helpers ──────────────────────────────────────────────────

async function gistFetch(path, method = 'GET', body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/** Fetch all user gists (up to 300), return Map<description, gistId>. */
async function fetchExisting() {
  const map = new Map();
  for (let page = 1; page <= 3; page++) {
    const gists = await gistFetch(`/gists?per_page=100&page=${page}`);
    for (const g of gists) map.set(g.description, g.id);
    if (gists.length < 100) break;
  }
  return map;
}

async function upsertGist(id, description, filename, tsContent, readmeContent) {
  const files = {
    'README.md':  { content: readmeContent },
    [filename]:   { content: tsContent },
  };
  if (id) {
    await gistFetch(`/gists/${id}`, 'PATCH', { description, files });
    return id;
  }
  const data = await gistFetch('/gists', 'POST', { description, public: true, files });
  return data.id;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.ts'));
const existing = await fetchExisting();

let created = 0, updated = 0, skipped = 0;

for (const file of files) {
  const meta = META[file];
  if (!meta) { console.warn(`  skip  ${file} (no metadata entry)`); skipped++; continue; }

  const raw     = readFileSync(join(EXAMPLES_DIR, file), 'utf8');
  const content = injectHeader(rewriteImports(raw), meta.install);
  const readme  = buildReadme(file, meta);

  const existingId = existing.get(meta.description) ?? null;
  const id = await upsertGist(existingId, meta.description, file, content, readme);

  if (existingId) {
    console.log(`  updated  ${file}  →  https://gist.github.com/${id}`);
    updated++;
  } else {
    console.log(`  created  ${file}  →  https://gist.github.com/${id}`);
    created++;
  }
}

console.log(`\nDone. created=${created} updated=${updated} skipped=${skipped}`);
