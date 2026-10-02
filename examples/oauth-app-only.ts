/**
 * Organisation-wide (app-only) access — no user sign-in.
 *
 * Google Workspace: a service account with domain-wide delegation acts as any mailbox.
 *   GOOGLE_SA_KEY=./service-account.json MAILBOX=support@company.com npx tsx examples/oauth-app-only.ts google
 *
 * Microsoft 365: client credentials (secret or certificate) — experimental.
 *   MS_TENANT=contoso.com MS_CLIENT_ID=… MS_CLIENT_SECRET=… MAILBOX=support@contoso.com \
 *     npx tsx examples/oauth-app-only.ts microsoft
 *
 * Admin setup (once):
 * - Google: Admin console → Security → API controls → Domain-wide delegation → add the service
 *   account's client ID with scope https://mail.google.com/
 * - Microsoft: application permissions IMAP.AccessAsApp + SMTP.SendAsApp (Office 365 Exchange Online)
 *   with admin consent; Exchange Online PowerShell: New-ServicePrincipal + Add-MailboxPermission.
 */
import { readFile } from 'fs/promises';
import { MailTs } from '../src/index.js';
import {
  google,
  microsoft,
  mailConfigFor,
  googleServiceAccountProvider,
  microsoftAppOnlyProvider,
  type TokenProvider,
} from '../src/oauth/index.js';

const which = process.argv[2] ?? 'google';
const mailbox = process.env['MAILBOX'];
if (!mailbox) { console.error('Set MAILBOX'); process.exit(1); }

let getToken: TokenProvider;
let provider;
if (which === 'google') {
  const credentials = JSON.parse(await readFile(process.env['GOOGLE_SA_KEY'] ?? 'service-account.json', 'utf8'));
  getToken = googleServiceAccountProvider({ credentials, subject: mailbox });
  provider = google;
} else {
  getToken = microsoftAppOnlyProvider({
    tenant: process.env['MS_TENANT']!,
    clientId: process.env['MS_CLIENT_ID']!,
    clientSecret: process.env['MS_CLIENT_SECRET'],   // or certificate: { privateKey, thumbprint }
  });
  provider = microsoft();
}

const mail = new MailTs({ ...mailConfigFor(provider, { user: mailbox, getToken }), attachmentPolicy: 'deny' });

// Read the shared mailbox
const status = await mail.imap.open('INBOX');
console.log(`${mailbox}: ${status.exists} messages, ${status.unseen} unseen`);

// Send as it
const r = await mail.send({ from: mailbox, to: mailbox, subject: 'App-only test', text: 'Sent without a user sign-in.' });
console.log(r.ok ? `Sent ${r.messageId}` : `Failed: ${r.error.message}`);
await mail.shutdown();
