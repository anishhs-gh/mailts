import { MailTs } from '@mailts/core';
import type { SmtpConfig, QueueJob, QueueOptions } from '@mailts/core';
import { loadEffectiveConfig } from './configure.js';
import { printSuccess, printError, printInfo } from '../prompt.js';

interface QueueArgs {
  subcommand?: string;
  jobId?: string;
  json?: boolean;
}

export async function queueCommand(args: QueueArgs): Promise<void> {
  const { subcommand = 'status' } = args;
  const globalCfg = loadEffectiveConfig();
  const smtpConfig = globalCfg['smtp'] as SmtpConfig | undefined;

  if (!smtpConfig) {
    printError('SMTP not configured. Run `mailts configure` first.');
    process.exitCode = 1;
    return;
  }

  const mail = new MailTs({
    smtp: smtpConfig,
    queue: globalCfg['queue'] as QueueOptions | undefined,
    logger: { level: 'warn', format: 'pretty' },
  });

  switch (subcommand) {
    case 'status': {
      const stats = mail.queue.stats();
      if (args.json) { process.stdout.write(JSON.stringify(stats, null, 2) + '\n'); break; }
      printInfo('Queue stats:');
      process.stdout.write(
        `  Pending:   ${stats.pending}\n` +
        `  Running:   ${stats.running}\n` +
        `  Succeeded: ${stats.succeeded}\n` +
        `  Dead:      ${stats.dead}\n`,
      );
      break;
    }

    case 'drain':
      printInfo('Waiting for queue to drain...');
      await mail.queue.drain();
      printSuccess('Queue drained.');
      break;

    case 'dlq':
      await handleDlq(mail, args.jobId ? 'retry' : 'list', args);
      break;

    default:
      printError(`Unknown queue subcommand: ${subcommand}`);
      printInfo('Available: status | drain | dlq [list|retry <job-id>]');
      process.exitCode = 1;
  }

  await mail.shutdown();
}

async function handleDlq(mail: MailTs, sub: string, args: QueueArgs): Promise<void> {
  switch (sub) {
    case 'list': {
      const jobs = mail.queue.dlq.getAll();
      if (jobs.length === 0) { printInfo('Dead-letter queue is empty.'); return; }
      if (args.json) { process.stdout.write(JSON.stringify(jobs, null, 2) + '\n'); return; }
      printInfo(`Dead-letter queue (${jobs.length} jobs):`);
      for (const job of jobs) {
        const lastErr = job.errors.at(-1)?.message ?? 'unknown error';
        process.stdout.write(
          `  \x1b[31m${job.id}\x1b[0m  attempts=${job.attempts}  created=${job.createdAt.toISOString()}  error="${lastErr}"\n`,
        );
      }
      break;
    }

    case 'retry': {
      const id = args.jobId;
      if (!id) { printError('Job ID required: mailts queue dlq retry <job-id>'); return; }
      const job = mail.queue.dlq.get(id);
      if (!job) { printError(`Job "${id}" not found in DLQ.`); return; }
      mail.queue.dlq.remove(id);
      const requeued: QueueJob = { ...job, attempts: 0, errors: [], status: 'pending', lastAttemptAt: null };
      printInfo(`Re-queuing job ${id}...`);
      mail.queue.enqueue(requeued.options);
      mail.queue.on('success', (j: QueueJob) => { if (j.options === requeued.options) printSuccess(`Job ${id} succeeded.`); });
      mail.queue.on('dead', (j: QueueJob) => { if (j.options === requeued.options) printError(`Job ${id} failed again and is back in DLQ.`); });
      await mail.queue.drain();
      break;
    }

    default:
      printError(`Unknown dlq subcommand: ${sub}`);
      printInfo('Available: list | retry <job-id>');
      process.exitCode = 1;
  }
}
