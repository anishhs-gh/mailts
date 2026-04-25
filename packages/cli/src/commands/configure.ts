import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { prompt, printHeader, printSuccess } from '../prompt.js';

const CONFIG_DIR = join(homedir(), '.mailts');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export async function configureSMTP(): Promise<void> {
  printHeader('mailts — SMTP Configuration');

  const host = await prompt({ name: 'host', message: 'SMTP host', validate: v => v ? null : 'Host is required' });
  const portStr = await prompt({ name: 'port', message: 'Port', placeholder: '587' });
  const port = parseInt(portStr || '587', 10);
  const secureStr = await prompt({ name: 'secure', message: 'Encryption (starttls/ssl/none)', placeholder: 'starttls' });
  const secure = secureStr.toLowerCase() === 'ssl';
  const user = await prompt({ name: 'user', message: 'Username (leave blank to skip auth)' });
  let pass = '';
  if (user) pass = await prompt({ name: 'pass', message: 'Password', secret: true });

  const config = loadOrDefault();
  config.smtp = { host, port, secure, ...(user ? { auth: { type: 'plain', user, pass } } : {}) };
  save(config);
  printSuccess(`Config saved to ${CONFIG_FILE}`);
}

export function loadGlobalConfig(): Record<string, unknown> {
  return loadOrDefault();
}

function loadOrDefault(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

function save(config: Record<string, unknown>): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

export function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') return obj.replace(/\$\{([^}]+)\}/g, (_m, k: string) => process.env[k] ?? '');
  if (Array.isArray(obj)) return obj.map(expandEnvVars);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = expandEnvVars(v);
    return out;
  }
  return obj;
}
