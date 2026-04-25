import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { expandEnv, loadConfig } from '../../../src/core/Config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('expandEnv', () => {
  beforeEach(() => {
    process.env['TEST_HOST'] = 'smtp.example.com';
    process.env['TEST_PORT'] = '587';
    process.env['TEST_USER'] = 'user@example.com';
  });

  afterEach(() => {
    delete process.env['TEST_HOST'];
    delete process.env['TEST_PORT'];
    delete process.env['TEST_USER'];
  });

  it('expands a single env var in a string', () => {
    expect(expandEnv('${TEST_HOST}')).toBe('smtp.example.com');
  });

  it('expands multiple env vars in one string', () => {
    expect(expandEnv('${TEST_HOST}:${TEST_PORT}')).toBe('smtp.example.com:587');
  });

  it('replaces missing env var with empty string', () => {
    expect(expandEnv('${TOTALLY_MISSING_VAR_XYZ}')).toBe('');
  });

  it('passes through non-string primitives unchanged', () => {
    expect(expandEnv(42)).toBe(42);
    expect(expandEnv(true)).toBe(true);
    expect(expandEnv(null)).toBe(null);
  });

  it('expands strings inside an array', () => {
    const result = expandEnv(['${TEST_HOST}', 'literal']) as string[];
    expect(result[0]).toBe('smtp.example.com');
    expect(result[1]).toBe('literal');
  });

  it('expands strings inside a nested object', () => {
    const result = expandEnv({ host: '${TEST_HOST}', port: 587 }) as Record<string, unknown>;
    expect(result['host']).toBe('smtp.example.com');
    expect(result['port']).toBe(587);
  });

  it('expands deeply nested objects', () => {
    const result = expandEnv({
      smtp: {
        host: '${TEST_HOST}',
        auth: { user: '${TEST_USER}' },
      },
    }) as Record<string, unknown>;
    const smtp = result['smtp'] as Record<string, unknown>;
    expect(smtp['host']).toBe('smtp.example.com');
    const auth = smtp['auth'] as Record<string, unknown>;
    expect(auth['user']).toBe('user@example.com');
  });

  it('expands strings inside arrays inside objects', () => {
    const result = expandEnv({ hosts: ['${TEST_HOST}', '${TEST_PORT}'] }) as Record<string, unknown>;
    expect(result['hosts']).toEqual(['smtp.example.com', '587']);
  });

  it('returns a string with no placeholders unchanged', () => {
    expect(expandEnv('no placeholders here')).toBe('no placeholders here');
  });

  it('leaves ${} with no name unchanged (regex requires at least one char)', () => {
    // The regex uses [^}]+ which requires ≥1 char — ${} has no key so it's not replaced
    const result = expandEnv('${}') as string;
    expect(result).toBe('${}');
  });
});

describe('loadConfig', () => {
  let tmpDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailts-config-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no config files exist', () => {
    expect(loadConfig()).toBeNull();
  });

  it('loads .mailtsrc from cwd', () => {
    fs.writeFileSync(path.join(tmpDir, '.mailtsrc'), JSON.stringify({ smtp: { host: 'local.example.com' } }));
    const config = loadConfig();
    expect(config).not.toBeNull();
    expect((config as unknown as Record<string, unknown>)['smtp']).toMatchObject({ host: 'local.example.com' });
  });

  it('loads .mailtsrc.json from cwd', () => {
    fs.writeFileSync(path.join(tmpDir, '.mailtsrc.json'), JSON.stringify({ smtp: { port: 465 } }));
    const config = loadConfig();
    expect(config).not.toBeNull();
  });

  it('expands env vars in loaded config', () => {
    process.env['MAILTS_TEST_HOST'] = 'env.example.com';
    fs.writeFileSync(path.join(tmpDir, '.mailtsrc'), JSON.stringify({ smtp: { host: '${MAILTS_TEST_HOST}' } }));
    const config = loadConfig() as Record<string, unknown>;
    const smtp = config['smtp'] as Record<string, unknown>;
    expect(smtp['host']).toBe('env.example.com');
    delete process.env['MAILTS_TEST_HOST'];
  });

  it('prefers .mailtsrc over .mailtsrc.json', () => {
    fs.writeFileSync(path.join(tmpDir, '.mailtsrc'), JSON.stringify({ from: 'rc@example.com' }));
    fs.writeFileSync(path.join(tmpDir, '.mailtsrc.json'), JSON.stringify({ from: 'rcjson@example.com' }));
    const config = loadConfig() as Record<string, unknown>;
    expect(config['from']).toBe('rc@example.com');
  });

  it('returns null for a cwd config file with invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.mailtsrc'), 'not valid json {{{{');
    const config = loadConfig();
    expect(config).toBeNull();
  });
});
