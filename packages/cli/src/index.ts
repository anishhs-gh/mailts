import { parseArgs } from 'util';
import { testSmtp } from './commands/test.js';
import { sendEmail } from './commands/send.js';
import { readMail } from './commands/read.js';
import { configureSMTP } from './commands/configure.js';
import { queueCommand } from './commands/queue.js';
import { trapCommand } from './commands/trap.js';
import { printError } from './prompt.js';

const VERSION = '0.1.3';

const HELP = `
mailts — Modern SMTP/IMAP CLI  v${VERSION}

USAGE
  mailts <command> [options]

COMMANDS
  configure [--local]           Interactive SMTP setup
  test [options]                Test SMTP connection with live protocol stream
  send [options]                Send an email
  read [options]                Read emails via IMAP
  queue <subcommand>            Manage the send queue
  trap [options]                Start a local SMTP trap server (requires @mailts/trap)
  version                       Print version and exit

CONFIGURE OPTIONS
  --local                       Save to .mailtsrc in the current directory instead of ~/.mailts/config.json

TEST OPTIONS
  --host <host>                 SMTP server hostname (required)
  --port <port>                 Port (default: 587)
  --encryption <enc>            STARTTLS | SSL_TLS | NONE  (default: STARTTLS)
  --username <user>             SMTP username
  --password <pass>             SMTP password (prefer MAILTS_PASSWORD env var)
  --client-name <name>          EHLO hostname  (default: mailts.local)

SEND OPTIONS
  --from <email>                Sender address
  --to <email>                  Recipient address (required unless --alias)
  --subject <text>              Subject line
  --text <text>                 Plain text body
  --html <file|text>            HTML body — file path or inline HTML string
  --attachments <paths>         Comma-separated file paths
  --alias <name>                Trigger a predefined alias from config

READ OPTIONS
  --mailbox <name>              Mailbox to open  (default: INBOX)
  --limit <n>                   Max messages to list  (default: 10)
  --unseen                      Show only unread messages

QUEUE SUBCOMMANDS
  queue status [--json]         Print pending / running / succeeded / dead counts
  queue drain                   Wait until all enqueued jobs finish
  queue dlq list [--json]       List jobs in the dead-letter queue
  queue dlq retry <job-id>      Re-enqueue a dead-letter job

TRAP OPTIONS
  --smtp-port <port>            SMTP listen port  (default: 1025)
  --http-port <port>            HTTP/UI listen port  (default: 1080)
  --host <host>                 Bind address  (default: 127.0.0.1)
  --max-messages <n>            In-memory message cap  (default: 100)
  --persist [dir]               Persist messages to disk; omit dir for .mailts-trap/ in cwd
  --no-open                     Don't auto-open browser
  --quiet                       Suppress startup output

ENVIRONMENT
  MAILTS_PASSWORD               SMTP password for 'mailts test'

EXAMPLES
  mailts configure
  mailts test --host smtp.gmail.com
  mailts test --host smtp.gmail.com --port 465 --encryption SSL_TLS
  MAILTS_PASSWORD=secret mailts test --host smtp.gmail.com --username me@gmail.com
  mailts send --to you@example.com --subject "Hi" --text "Hello"
  mailts send --to you@example.com --html ./email.html --attachments report.pdf
  mailts send --alias welcome --to newuser@example.com
  mailts read --limit 20 --unseen
  mailts queue status
  mailts queue dlq list
  mailts queue dlq retry a1b2c3d4e5f6
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP + '\n'); return;
  }
  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`mailts v${VERSION}\n`); return;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  try {
    switch (command) {
      case 'configure': {
        const { values: cfgValues } = parseArgs({
          args: rest,
          options: { local: { type: 'boolean' } },
          strict: false,
        });
        await configureSMTP({ local: cfgValues['local'] as boolean | undefined });
        break;
      }

      case 'test': {
        const { values } = parseArgs({
          args: rest,
          options: {
            host:          { type: 'string' },
            port:          { type: 'string' },
            encryption:    { type: 'string' },
            username:      { type: 'string' },
            password:      { type: 'string' },
            'client-name': { type: 'string' },
          },
          strict: false,
        });
        await testSmtp({
          host:       values['host'] as string | undefined,
          port:       values['port'] as string | undefined,
          encryption: values['encryption'] as string | undefined,
          username:   values['username'] as string | undefined,
          password:   values['password'] as string | undefined,
          clientName: values['client-name'] as string | undefined,
        });
        break;
      }

      case 'send': {
        const { values } = parseArgs({
          args: rest,
          options: {
            host:        { type: 'string' },
            port:        { type: 'string' },
            from:        { type: 'string' },
            to:          { type: 'string' },
            subject:     { type: 'string' },
            text:        { type: 'string' },
            html:        { type: 'string' },
            attachments: { type: 'string' },
            alias:       { type: 'string' },
          },
          strict: false,
        });
        if (!values['to'] && !values['alias']) {
          printError('--to is required (or use --alias)'); process.exitCode = 1; return;
        }
        await sendEmail({
          host:        values['host'] as string | undefined,
          port:        values['port'] as string | undefined,
          from:        values['from'] as string | undefined,
          to:          (values['to'] as string | undefined) ?? '',
          subject:     values['subject'] as string | undefined,
          text:        values['text'] as string | undefined,
          html:        values['html'] as string | undefined,
          attachments: values['attachments'] as string | undefined,
          alias:       values['alias'] as string | undefined,
        });
        break;
      }

      case 'read': {
        const { values } = parseArgs({
          args: rest,
          options: {
            mailbox: { type: 'string' },
            limit:   { type: 'string' },
            unseen:  { type: 'boolean' },
          },
          strict: false,
        });
        await readMail({
          mailbox: values['mailbox'] as string | undefined,
          limit:   values['limit'] as string | undefined,
          unseen:  values['unseen'] as boolean | undefined,
        });
        break;
      }

      case 'queue': {
        const sub = rest[0] ?? 'status';
        const { values, positionals } = parseArgs({
          args: rest.slice(1),
          options: { json: { type: 'boolean' } },
          strict: false,
          allowPositionals: true,
        });
        if (sub === 'dlq') {
          const dlqSub = positionals[0] ?? 'list';
          const jobId  = positionals[1];
          await queueCommand({ subcommand: 'dlq', jobId: dlqSub === 'retry' ? jobId : undefined, json: values['json'] as boolean | undefined });
        } else {
          await queueCommand({ subcommand: sub, json: values['json'] as boolean | undefined });
        }
        break;
      }

      case 'trap':
        await trapCommand(rest);
        break;

      default:
        printError(`Unknown command: "${command}"`);
        process.stdout.write(HELP + '\n');
        process.exitCode = 1;
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
