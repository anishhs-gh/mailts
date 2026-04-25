import { MailTs } from 'mailts';
import type { ImapConfig } from 'mailts';
import { loadGlobalConfig, expandEnvVars } from './configure.js';
import { printError, printInfo } from '../prompt.js';

interface ReadArgs {
  mailbox?: string;
  limit?: string;
  unseen?: boolean;
}

export async function readMail(args: ReadArgs): Promise<void> {
  const globalCfg = expandEnvVars(loadGlobalConfig()) as Record<string, unknown>;
  const imapConfig = globalCfg['imap'] as ImapConfig | undefined;

  if (!imapConfig) {
    printError('IMAP not configured. Add imap section to ~/.mailts/config.json');
    process.exitCode = 1;
    return;
  }

  const mail = new MailTs({ imap: imapConfig, logger: { level: 'info', format: 'pretty' } });
  const mailbox = args.mailbox ?? 'INBOX';
  const limit = args.limit ? parseInt(args.limit, 10) : 10;

  printInfo(`Opening ${mailbox}...`);

  const session = mail.imap;
  try {
    await session.connect();
    const status = await session.open(mailbox);
    printInfo(`${mailbox}: ${status.exists} messages, ${status.unseen} unseen`);

    const messages = await session.fetch({ seen: args.unseen ? false : undefined, limit });
    if (messages.length === 0) { printInfo('No messages found.'); return; }

    for (const msg of messages) {
      const from = msg.envelope.from[0] as { name?: string; email: string } | undefined;
      const fromStr = from ? (from.name ? `${from.name} <${from.email}>` : from.email) : 'unknown';
      const date = msg.envelope.date?.toLocaleString() ?? msg.internalDate?.toLocaleString() ?? '';
      const seen = msg.flags.includes('\\Seen') ? '' : '\x1b[1m[NEW]\x1b[0m ';
      process.stdout.write(
        `${seen}\x1b[36m${msg.uid.toString().padStart(5)}\x1b[0m  ${date.padEnd(25)}  ${fromStr.padEnd(35)}  ${msg.envelope.subject}\n`,
      );
    }
  } finally {
    await session.close().catch(() => {});
  }
}
