/**
 * Bulk-sender essentials: one-click unsubscribe (RFC 8058), rate limits, and
 * idempotency so a retried job never emails someone twice.
 *
 * Run:  npx tsx examples/newsletter-unsubscribe.ts   (uses a console transport)
 */
import { createHmac } from 'crypto';
import { createServer } from 'http';
import { MailTs, isOneClickUnsubscribe } from '../src/index.js';

const SECRET = 'replace-me';
const token = (email: string) => createHmac('sha256', SECRET).update(email).digest('base64url');

const mail = new MailTs({
  transport: {
    name: 'console',
    async send(m, o) {
      console.log(`→ ${o.to} "${o.subject}"`);
      return { messageId: m.messageId, accepted: m.to, rejected: [] };
    },
  },
  queue: {
    rateLimit: { perSecond: 5 },          // e.g. Microsoft 365: { perMinute: 30 }
    idempotencyWindowMs: 30 * 86_400_000, // remember campaign keys for 30 days
  },
});

const subscribers = ['a@example.com', 'b@example.com', 'c@example.com'];
const campaign = '2026-10-newsletter';

for (const email of subscribers) {
  mail.queue.enqueue({
    from: 'news@example.com',
    to: email,
    subject: 'October update',
    html: '<p>News…</p>',
    unsubscribe: {
      url: `https://example.com/unsubscribe?e=${encodeURIComponent(email)}&t=${token(email)}`,
      mailto: 'unsubscribe@example.com',
    },
  }, { idempotencyKey: `${campaign}:${email}` });
}
// A re-run of the campaign job is a no-op: same keys → same jobs
mail.queue.enqueue({ from: 'news@example.com', to: 'a@example.com', subject: 'dup', text: 'x' }, { idempotencyKey: `${campaign}:a@example.com` });

await mail.queue.drain();
await mail.shutdown();

// The unsubscribe endpoint (mailbox providers POST "List-Unsubscribe=One-Click")
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'https://example.com');
    const email = url.searchParams.get('e') ?? '';
    if (isOneClickUnsubscribe({ method: req.method, contentType: req.headers['content-type'], body }) &&
        url.searchParams.get('t') === token(email)) {
      console.log(`Unsubscribed ${email}`);   // no login, no confirmation page
      res.writeHead(200).end();
      return;
    }
    res.writeHead(400).end();
  });
});
server.listen(0, () => server.close());
