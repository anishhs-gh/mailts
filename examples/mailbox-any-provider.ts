/**
 * One code path for IMAP, Microsoft Graph and the Gmail API via the `Mailbox` interface.
 *
 *   PROVIDER=imap  IMAP_HOST=… MAIL_USER=… MAIL_PASS=…                         npx tsx examples/mailbox-any-provider.ts
 *   PROVIDER=gmail MAIL_USER=… GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=… npx tsx …
 *   PROVIDER=graph MAIL_USER=… MS_CLIENT_ID=… MS_REFRESH_TOKEN=… [MS_TENANT=…]  npx tsx …   (experimental)
 */
import { ImapSession, imapMailbox, GraphMailbox, GmailMailbox, type Mailbox } from '../src/index.js';
import { googleTokenProvider, microsoftTokenProvider, microsoft } from '../src/oauth/index.js';

const user = process.env['MAIL_USER']!;

function open(): Mailbox {
  switch (process.env['PROVIDER'] ?? 'imap') {
    case 'gmail':
      return new GmailMailbox({
        user,
        getToken: googleTokenProvider({
          clientId: process.env['GOOGLE_CLIENT_ID']!, clientSecret: process.env['GOOGLE_CLIENT_SECRET']!,
          refreshToken: process.env['GOOGLE_REFRESH_TOKEN']!,
        }),
      });
    case 'graph':
      return new GraphMailbox({
        user,
        getToken: microsoftTokenProvider({
          provider: microsoft({ tenant: process.env['MS_TENANT'] ?? 'common', api: 'graph' }),
          clientId: process.env['MS_CLIENT_ID']!, refreshToken: process.env['MS_REFRESH_TOKEN']!,
        }),
      });
    default:
      return imapMailbox(new ImapSession({
        host: process.env['IMAP_HOST']!, port: 993, secure: true,
        auth: { type: 'plain', user, pass: process.env['MAIL_PASS']! },
      }));
  }
}

// Everything below is provider-neutral
async function triage(box: Mailbox): Promise<void> {
  console.log(`Provider: ${box.provider}`);
  console.log('Folders:', (await box.listMailboxes()).map(f => f.specialUse ? `${f.name} (${f.specialUse})` : f.name).join(', '));
  console.log('INBOX:', await box.status('INBOX'));

  const unread = await box.fetch({ search: { seen: false }, limit: 5 });
  for (const m of unread) {
    console.log(`• [${m.id}] ${m.envelope.subject} — ${(m.envelope.from[0] as { email: string } | undefined)?.email}`);
  }
  if (unread[0]) {
    const [full] = await box.fetch({ ids: [unread[0].id], bodies: true });
    console.log('First message body:', full?.body?.text?.slice(0, 120));
  }

  const watcher = await box.watch('INBOX', { pollMs: 15_000 });
  watcher.on('new', (ids: string[]) => console.log('New mail:', ids));
  await new Promise(r => setTimeout(r, 30_000));
  await watcher.stop();
}

const box = open();
await triage(box);
await box.close();
