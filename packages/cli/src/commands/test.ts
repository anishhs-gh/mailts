import { SmtpClient, Logger } from '@mailts/core';
import type { SmtpConfig } from '@mailts/core';
import { printHeader, printSuccess, printError, printInfo, prompt } from '../prompt.js';

interface TestArgs {
  host?: string;
  port?: string;
  encryption?: string;
  username?: string;
  password?: string;
  clientName?: string;
}

export async function testSmtp(args: TestArgs): Promise<void> {
  printHeader('mailts — SMTP Connection Test');

  const host = args.host ?? await prompt({ name: 'host', message: 'SMTP host', validate: v => v ? null : 'Host is required' });
  const portStr = args.port ?? await prompt({ name: 'port', message: 'Port', placeholder: '587' });
  const port = parseInt(portStr || '587', 10);
  const enc = (args.encryption ?? await prompt({ name: 'enc', message: 'Encryption (STARTTLS/SSL_TLS/NONE)', placeholder: 'STARTTLS' })).toUpperCase();
  const secure = enc === 'SSL_TLS' || enc === 'SSL';
  const username = args.username ?? await prompt({ name: 'user', message: 'Username (blank = no auth)' });
  let password = '';
  if (username) {
    password = args.password ?? process.env['SMTP8_PASSWORD'] ?? process.env['MAILTS_PASSWORD'] ??
      await prompt({ name: 'pass', message: 'Password', secret: true });
  }

  const config: SmtpConfig = {
    host, port, secure,
    clientName: args.clientName ?? 'mailts.local',
    ...(username ? { auth: { type: 'plain', user: username, pass: password } } : {}),
  };

  printInfo(`Connecting to ${host}:${port} (${enc})...`);

  const logger = new Logger({ level: 'debug', protocol: true });
  logger.onEvent((e) => {
    const dir = e.direction ? ` [${e.direction === 'C' ? 'C→S' : 'S→C'}]` : '';
    const color = e.direction === 'C' ? '\x1b[36m' : '\x1b[33m';
    process.stdout.write(`${color}${dir || '[INFO]'}\x1b[0m ${e.message}\n`);
  });

  const client = new SmtpClient(config, logger);
  try {
    await client.connect();
    printSuccess(`Connection to ${host}:${port} successful`);
    if (username) printSuccess('Authentication successful');
  } catch (err) {
    printError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.quit().catch(() => {});
  }
}
