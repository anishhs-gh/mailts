import { SqliteQueue, resolveQueueDbPath } from '@mailts/core';
import type { QueueOptions } from '@mailts/core';
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
  const queueCfg = globalCfg['queue'] as QueueOptions | undefined;
  const persistCfg = queueCfg?.persist;

  if (!persistCfg) {
    printError('Queue commands require queue.persist in config (needs Node 22+). Add: { "queue": { "persist": true } } to ~/.mailts/config.json');
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveQueueDbPath(persistCfg);

  switch (subcommand) {
    case 'status': {
      const stats = SqliteQueue.readStats(dbPath);
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
      printInfo('drain is not supported cross-process — jobs drain in the application process.');
      break;

    case 'dlq':
      handleDlq(dbPath, args.jobId ? 'retry' : 'list', args);
      break;

    default:
      printError(`Unknown queue subcommand: ${subcommand}`);
      printInfo('Available: status | drain | dlq [list|retry <job-id>|clear]');
      process.exitCode = 1;
  }
}

function handleDlq(dbPath: string, sub: string, args: QueueArgs): void {
  switch (sub) {
    case 'list': {
      const jobs = SqliteQueue.readDlq(dbPath);
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
      const ok = SqliteQueue.requeueJob(dbPath, id);
      if (!ok) { printError(`Job "${id}" not found in DLQ.`); return; }
      printSuccess(`Job ${id} re-queued. The app will pick it up on its next poll (every 5s).`);
      break;
    }

    case 'clear':
      SqliteQueue.clearDlq(dbPath);
      printSuccess('Dead-letter queue cleared.');
      break;

    default:
      printError(`Unknown dlq subcommand: ${sub}`);
      printInfo('Available: list | retry <job-id> | clear');
      process.exitCode = 1;
  }
}
