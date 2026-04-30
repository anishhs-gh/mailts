import { readFileSync, existsSync } from 'fs';
import { MailTs } from '@mailts/core';
import type { SmtpConfig, EmailOptions } from '@mailts/core';
import { loadEffectiveConfig } from './configure.js';
import { printSuccess, printError, printInfo } from '../prompt.js';

interface SendArgs {
  from?: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: string;
  alias?: string;
}

export async function sendEmail(args: SendArgs): Promise<void> {
  const globalCfg = loadEffectiveConfig();
  const smtpConfig = globalCfg['smtp'] as SmtpConfig | undefined;

  if (!smtpConfig) {
    printError('SMTP not configured. Run `mailts configure` or add an smtp section to .mailtsrc');
    process.exitCode = 1;
    return;
  }

  const mail = new MailTs({ smtp: smtpConfig, logger: { level: 'info', format: 'pretty' } });

  if (args.alias) {
    const aliases = (globalCfg['aliases'] as Record<string, unknown> | undefined) ?? {};
    const aliasConfig = aliases[args.alias];
    if (!aliasConfig) { printError(`Alias "${args.alias}" not found in config`); process.exitCode = 1; return; }
    mail.define(args.alias, aliasConfig as object);
    printInfo(`Triggering alias: ${args.alias}`);
    const result = await mail.trigger(args.alias, args.to ? { to: args.to } : {});
    if (result.ok) { printSuccess(`Sent (${result.messageId})`); }
    else { printError(`Failed: ${result.error.message}`); process.exitCode = 1; }
    return;
  }

  const options: EmailOptions = { from: args.from, to: args.to, subject: args.subject, text: args.text };
  if (args.html) options.html = existsSync(args.html) ? readFileSync(args.html, 'utf8') : args.html;
  if (args.attachments) {
    options.attachments = args.attachments.split(',').map(p => ({
      filename: p.trim().split('/').pop() ?? p.trim(),
      path: p.trim(),
    }));
  }

  printInfo(`Sending to ${args.to}...`);
  const result = await mail.send(options);
  if (result.ok) { printSuccess(`Sent successfully (${result.messageId})`); }
  else { printError(`Failed: ${result.error.message}`); process.exitCode = 1; }
  await mail.shutdown();
}
