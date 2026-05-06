/**
 * Health checks — K8s liveness / readiness probes.
 *
 * mail.health() pings SMTP (EHLO + NOOP) and IMAP (connect + open INBOX),
 * measures latency, and returns a structured result. No external dependencies.
 *
 * Run:  npx tsx examples/health-checks.ts
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: process.env['SMTP_USER']!, pass: process.env['SMTP_PASS']! },
  },
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { type: 'plain', user: process.env['SMTP_USER']!, pass: process.env['SMTP_PASS']! },
  },
});

// ── Full health check ──────────────────────────────────────────────────────────
const result = await mail.health();
console.log('Health check result:');
console.log(JSON.stringify(result, null, 2));

// ── K8s-style probe handler ────────────────────────────────────────────────────
//
// import http from 'http';
// http.createServer(async (req, res) => {
//   if (req.url === '/healthz') {
//     const h = await mail.health();
//     const ok = !h.smtp || h.smtp.ok;   // readiness: SMTP reachable
//     res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify(h));
//   }
// }).listen(8080);

// ── SMTP only ─────────────────────────────────────────────────────────────────
// import { HealthChecker } from '@mailts/core';
// const checker = new HealthChecker(smtpConfig, null);
// const smtpHealth = await checker.checkSmtp();
// console.log(smtpHealth); // { ok: true, latencyMs: 42 }
