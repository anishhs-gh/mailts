#!/usr/bin/env node
/**
 * Download (checksum-verified) and run GreenMail — a real IMAP/SMTP server —
 * for integration tests. Requires Java 11+.
 *
 *   node scripts/greenmail.mjs            # run in the foreground (Ctrl+C to stop)
 *   import { startGreenMail } from './scripts/greenmail.mjs'   # from tests
 *
 * Ports (GreenMail "test" setup): SMTP 3025, SMTPS 3465, IMAP 3143, IMAPS 3993.
 * Users are created on first login (auth is not checked).
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const VERSION = '2.1.14';
const SHA256 = '0381392f3a44e4d8ae78051778440f58820d01acaf5757c3f43649deda8c1d23';
const URL_ = `https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/${VERSION}/greenmail-standalone-${VERSION}.jar`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = (process.env.GREENMAIL_CACHE ?? join(ROOT, 'node_modules', '.cache', 'greenmail')).replace(/^~(?=$|\/)/, homedir());
const JAR = join(CACHE, `greenmail-standalone-${VERSION}.jar`);

export const PORTS = { smtp: 3025, smtps: 3465, imap: 3143, imaps: 3993 };

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function ensureJar() {
  if (existsSync(JAR) && sha256(readFileSync(JAR)) === SHA256) return JAR;
  mkdirSync(CACHE, { recursive: true });
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`GreenMail download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== SHA256) throw new Error(`GreenMail checksum mismatch: expected ${SHA256}, got ${got}`);
  writeFileSync(`${JAR}.tmp`, buf);
  renameSync(`${JAR}.tmp`, JAR);
  return JAR;
}

function portOpen(port) {
  return new Promise(resolve => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** Start GreenMail; resolves once every port accepts connections. Returns `stop()`. */
export async function startGreenMail({ timeoutMs = 60_000 } = {}) {
  const jar = await ensureJar();
  const child = spawn('java', [
    '-Dgreenmail.setup.test.all',
    '-Dgreenmail.hostname=127.0.0.1',
    '-Dgreenmail.auth.disabled',
    '-Dgreenmail.startup.timeout=30000',
    '-jar', jar,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(r => child.once('exit', r));

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = (await Promise.all(Object.values(PORTS).map(portOpen))).every(Boolean);
    if (ready) break;
    if (child.exitCode !== null) throw new Error(`GreenMail exited early (${child.exitCode}): ${stderr.slice(-2000)}`);
    if (Date.now() > deadline) { child.kill(); throw new Error('GreenMail did not start in time'); }
    await new Promise(r => setTimeout(r, 250));
  }

  return {
    ports: PORTS,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gm = await startGreenMail();
  process.stderr.write(`GreenMail ${VERSION} running: SMTP ${PORTS.smtp}, IMAP ${PORTS.imap}, IMAPS ${PORTS.imaps}\n`);
  const stop = () => gm.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
