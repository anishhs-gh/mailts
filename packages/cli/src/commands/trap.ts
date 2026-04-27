import { parseArgs } from 'util';

export async function trapCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'smtp-port':    { type: 'string',  default: '1025' },
      'http-port':    { type: 'string',  default: '1080' },
      host:           { type: 'string',  default: '127.0.0.1' },
      'max-messages': { type: 'string',  default: '100' },
      persist:        { type: 'string' },
      'no-open':      { type: 'boolean', default: false },
      quiet:          { type: 'boolean', default: false },
    },
    strict: false,
  });

  let TrapServer: (typeof import('@mailts/trap'))['TrapServer'];
  try {
    ({ TrapServer } = await import('@mailts/trap'));
  } catch {
    process.stderr.write('Error: @mailts/trap is not installed. Run: npm install --save-dev @mailts/trap\n');
    process.exitCode = 1;
    return;
  }

  const smtpPort = parseInt(values['smtp-port'] as string, 10);
  const httpPort = parseInt(values['http-port'] as string, 10);
  const host = values['host'] as string;

  const server = new TrapServer({
    smtpPort,
    httpPort,
    host,
    maxMessages: parseInt(values['max-messages'] as string, 10),
    persist: values['persist'] !== undefined ? (values['persist'] as string || true) : false,
  });

  await server.start();

  if (!values['quiet']) {
    process.stdout.write(`
@mailts/trap ready

  SMTP  →  ${host}:${smtpPort}  (catching all mail)
  UI    →  http://${host}:${httpPort}

Point your mailer at ${host}:${smtpPort} — no auth required.
Press Ctrl+C to stop.
`);
  }

  if (!values['no-open']) {
    const uiUrl = `http://${host}:${httpPort}`;
    const open = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    const { exec } = await import('child_process');
    exec(`${open} ${uiUrl}`);
  }

  process.on('SIGINT', () => {
    server.stop().then(() => process.exit(0));
  });

  await new Promise<never>(() => { /* keep alive */ });
}
