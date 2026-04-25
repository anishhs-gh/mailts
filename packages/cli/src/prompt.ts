import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

export interface PromptField {
  name: string;
  message: string;
  placeholder?: string;
  secret?: boolean;
  validate?: (v: string) => string | null;
}

export async function prompt(field: PromptField): Promise<string> {
  const rl = createInterface({ input, output, terminal: true });
  const hint = field.placeholder ? ` (${field.placeholder})` : '';
  const label = `${field.message}${hint}: `;

  try {
    if (field.secret) {
      output.write(label);
      const value = await readSecret(rl);
      output.write('\n');
      if (field.validate) {
        const err = field.validate(value);
        if (err) { output.write(`  ✗ ${err}\n`); rl.close(); return prompt(field); }
      }
      return value;
    }

    let value = await rl.question(label);
    if (!value && field.placeholder) value = field.placeholder;
    value = value.trim();
    if (field.validate) {
      const err = field.validate(value);
      if (err) { output.write(`  ✗ ${err}\n`); rl.close(); return prompt(field); }
    }
    return value;
  } finally {
    rl.close();
  }
}

function readSecret(rl: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise(resolve => {
    const chars: string[] = [];
    const onData = (key: Buffer | string) => {
      const char = key.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        resolve(chars.join(''));
      } else if (char === '\x7f' || char === '\x08') {
        chars.pop();
      } else if (char === '\x03') {
        process.exit(0);
      } else {
        chars.push(char);
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

export function printHeader(title: string): void {
  const line = '─'.repeat(title.length + 4);
  process.stdout.write(`\n┌${line}┐\n│  ${title}  │\n└${line}┘\n\n`);
}

export function printSuccess(msg: string): void { process.stdout.write(`\x1b[32m✓\x1b[0m ${msg}\n`); }
export function printError(msg: string): void   { process.stderr.write(`\x1b[31m✗\x1b[0m ${msg}\n`); }
export function printInfo(msg: string): void    { process.stdout.write(`\x1b[36mℹ\x1b[0m ${msg}\n`); }
