import { parseArgs } from 'util';
import { TrapServer } from './CatchServer.js';

const { values } = parseArgs({
  options: {
    'smtp-port':    { type: 'string',  default: '1025' },
    'http-port':    { type: 'string',  default: '1080' },
    host:           { type: 'string',  default: '127.0.0.1' },
    'max-messages': { type: 'string',  default: '100' },
    persist:        { type: 'string'  },
    'no-open':      { type: 'boolean', default: false },
    quiet:          { type: 'boolean', default: false },
    version:        { type: 'boolean', default: false },
    help:           { type: 'boolean', default: false },
  },
  strict: false,
});

if (values['help']) {
  process.stdout.write(`
@mailts/trap — Local mail trap server

USAGE
  npx @mailts/trap [options]

OPTIONS
  --smtp-port <port>     SMTP listen port      (default: 1025)
  --http-port <port>     HTTP/UI listen port   (default: 1080)
  --host <host>          Bind address          (default: 127.0.0.1)
  --max-messages <n>     In-memory cap         (default: 100)
  --no-open              Don't auto-open browser
  --quiet                Suppress startup output
  --version              Print version

EXAMPLES
  npx @mailts/trap
  npx @mailts/trap --smtp-port 2525 --http-port 8080
  npx @mailts/trap --host 0.0.0.0   # bind all interfaces (staging)
`);
  process.exit(0);
}

const server = new TrapServer({
  smtpPort:    parseInt(values['smtp-port'] as string, 10),
  httpPort:    parseInt(values['http-port'] as string, 10),
  host:        values['host'] as string,
  maxMessages: parseInt(values['max-messages'] as string, 10),
  persist:     values['persist'] !== undefined ? (values['persist'] as string || true) : false,
});

server.start().then(() => {
  if (!values['quiet']) {
    const smtpPort = values['smtp-port'] as string;
    const httpPort = values['http-port'] as string;
    const host = values['host'] as string;
    process.stdout.write(`
@mailts/trap ready

  SMTP  →  ${host}:${smtpPort}  (catching all mail)
  UI    →  http://${host}:${httpPort}

Point your mailer at ${host}:${smtpPort} — no auth required.
Press Ctrl+C to stop.
`);
  }

  if (!values['no-open']) {
    const uiUrl = `http://${values['host'] as string}:${values['http-port'] as string}`;
    const open = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    import('child_process').then(({ exec }) => exec(`${open} ${uiUrl}`));
  }
}).catch((err: unknown) => {
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

process.on('SIGINT', () => {
  server.stop().then(() => process.exit(0));
});
