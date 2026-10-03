import { describe, it, expect, afterEach } from 'vitest';
import { MailTs } from '../../../src/core/MailTs.js';
import { smtpServer } from '../../helpers/mockServers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(f => f())); });

describe('SMTP pool under load', () => {
  it('200 queued sends over 5 pooled connections with random 4xx and dropped connections', async () => {
    let n = 0;
    const srv = await smtpServer({
      handler: (line, socket) => {
        if (/^MAIL FROM/.test(line)) {
          const k = ++n;
          if (k % 17 === 0) { socket.destroy(); return true; }                  // connection drop mid-transaction
          if (k % 7 === 0) { socket.write('451 4.3.0 try again\r\n'); return true; } // transient failure
        }
        return false;
      },
    });
    cleanups.push(srv.close);
    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port: srv.port, secure: false, pool: { maxConnections: 5 }, socketTimeout: 2_000 },
      queue: { concurrency: 8, maxRetries: 6, retryDelay: 1, jitter: false },
    });
    mail.queue.on('dead', () => {});
    const jobs = Array.from({ length: 200 }, (_, i) => mail.queue.enqueue({ from: 'a@x.com', to: 'b@x.com', subject: `m${i}`, text: 'x' }));
    await mail.queue.drain();
    await mail.shutdown();

    expect(jobs.filter(j => j.status === 'success')).toHaveLength(200);
    // Each message reached the server exactly once
    const subjects = srv.state.messages.map(m => /Subject: (m\d+)/.exec(m)![1]);
    expect(subjects).toHaveLength(200);
    expect(new Set(subjects).size).toBe(200);
  }, 60_000);
});
