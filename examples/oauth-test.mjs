/**
 * Interactive OAuth smoke test for @mailts/core — Gmail or Microsoft 365.
 *
 *   npm run build            # once, so dist/ is up to date
 *   node examples/oauth-test.mjs
 *
 * Asks for your details, signs in through the browser, reads your 5 newest
 * INBOX subjects (read-only), sends one test email, then logs out and (for
 * Google) revokes access. Tokens stay in memory — nothing is saved.
 */
import { createInterface } from 'node:readline/promises';
import { MailTs, ImapSession } from '../dist/index.js';
import {
  authorizeWithLoopback,
  createTokenProvider,
  google,
  microsoft,
  mailConfigFor,
} from '../dist/oauth/index.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def) => ((await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def || '');

const time = async (label, fn) => {
  const t0 = performance.now();
  try {
    const result = await fn();
    console.log(`  ✔ ${label} (${Math.round(performance.now() - t0)} ms)`);
    return result;
  } catch (err) {
    console.log(`  ✘ ${label} (${Math.round(performance.now() - t0)} ms): ${err.message}`);
    return undefined;
  }
};

console.log('\nmailts OAuth test\n');
const which = (await ask('Provider — google or microsoft', 'google')).toLowerCase();
const isGoogle = which.startsWith('g');
const user = await ask('Your email address', isGoogle ? 'anishsh701@gmail.com' : 'shekhanish@rezolve.com');
const clientId = await ask('OAuth client ID');
const clientSecret = isGoogle ? await ask('OAuth client secret') : undefined;
const to = await ask('Send the test email to', user);
rl.close();

if (!clientId || (isGoogle && !clientSecret)) {
  console.error('Client ID (and, for Google, client secret) are required.');
  process.exit(1);
}

const provider = isGoogle ? google : microsoft({ tenant: user.split('@')[1] });

console.log('\n1. Sign in — your browser will open. Approve access, then come back here.');
const tokens = await time('Signed in', () =>
  authorizeWithLoopback({
    provider,
    clientId,
    clientSecret,
    loginHint: user,
    onAuthUrl: (url) => {
      console.log(`  If the browser did not open, visit:\n  ${url}\n`);
      return import('../dist/oauth/index.js').then(m => m.openBrowser(url)).catch(() => {});
    },
  }),
);
if (!tokens) process.exit(1);

const getToken = createTokenProvider({
  provider,
  clientId,
  clientSecret,
  refreshToken: tokens.refreshToken ?? '',
  accessToken: tokens.accessToken,
  expiresAt: tokens.expiresAt,
});
const config = mailConfigFor(provider, { user, getToken });
const imap = new ImapSession(config.imap);
const mail = new MailTs({ smtp: { ...config.smtp, pool: false } });

console.log('\n2. Read mail (IMAP, read-only)');
await time('Connected to IMAP', () => imap.connect());
const status = await time('Opened INBOX', () => imap.open('INBOX'));
if (status) console.log(`    ${status.exists} messages, ${status.unseen ?? '?'} unseen`);
const latest = await time('Fetched 5 newest headers', () => imap.fetch({ limit: 5 }));
for (const m of (latest ?? []).reverse()) {
  console.log(`    • ${m.envelope.subject || '(no subject)'}`);
}

console.log('\n3. Send a test email (SMTP)');
const sent = await time(`Sent to ${to}`, async () => {
  const r = await mail.send({
    from: user,
    to,
    subject: `mailts OAuth test — ${new Date().toLocaleString()}`,
    text: 'This email was sent by the @mailts/core OAuth test script. No reply needed.',
  });
  if (!r.ok) throw r.error;
  return r;
});
if (sent) console.log(`    Message-ID ${sent.messageId}`);

console.log('\n4. Log out');
await time('Closed IMAP (LOGOUT)', () => imap.close());
await time('Closed SMTP', () => mail.shutdown());
if (isGoogle) {
  await time('Revoked Google access', async () => {
    const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refreshToken ?? tokens.accessToken)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
} else {
  console.log('  To end the browser session too: https://login.microsoftonline.com/common/oauth2/v2.0/logout');
}

console.log(sent ? '\nDone — check the inbox for the test email.\n' : '\nFinished with errors (see above).\n');
process.exit(sent ? 0 : 1);
