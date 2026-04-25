import { createHash, createSign } from 'crypto';

export interface DkimConfig {
  /** Domain name (`d=` tag) — e.g. `example.com`. */
  domainName: string;
  /** Key selector (`s=` tag) — must match the DNS TXT record at `<selector>._domainkey.<domain>`. */
  keySelector: string;
  /** RSA private key in PEM format. */
  privateKey: string;
  /**
   * Headers to sign.  Order matters — headers are signed in the order listed.
   * @default ['from','to','subject','date','message-id','mime-version','content-type']
   */
  headerFieldNames?: string[];
}

const DEFAULT_HEADERS = [
  'from', 'to', 'subject', 'date', 'message-id',
  'mime-version', 'content-type', 'reply-to', 'cc',
];

/**
 * Signs a raw RFC 5322 message buffer with DKIM (rsa-sha256, relaxed/relaxed)
 * and returns a new buffer with the `DKIM-Signature` header prepended.
 */
export function signDkim(raw: Buffer, config: DkimConfig): Buffer {
  const msg = raw.toString('binary');

  // Split header block from body at first double CRLF
  const sep = msg.indexOf('\r\n\r\n');
  const rawHeaders = sep === -1 ? msg : msg.slice(0, sep);
  const rawBody = sep === -1 ? '' : msg.slice(sep + 4);

  // Parse header list preserving folded lines
  const parsedHeaders = parseHeaders(rawHeaders);

  // Canonicalize body (relaxed) and compute bh=
  const canonBody = canonicalizeBodyRelaxed(rawBody);
  const bh = createHash('sha256').update(canonBody, 'binary').digest('base64');

  const fieldNames = (config.headerFieldNames ?? DEFAULT_HEADERS)
    .map(h => h.toLowerCase())
    .filter(h => parsedHeaders.some(([n]) => n === h));

  // Build DKIM-Signature header value (without the `b=` value)
  const sigHeaderValue = [
    'v=1',
    'a=rsa-sha256',
    'c=relaxed/relaxed',
    `d=${config.domainName}`,
    `s=${config.keySelector}`,
    `h=${fieldNames.join(':')}`,
    `bh=${bh}`,
    'b=',
  ].join('; ');

  const sigHeaderName = 'DKIM-Signature';

  // Collect the headers to sign (last occurrence of each, in listed order)
  const toSign = fieldNames.map(name => {
    const found = [...parsedHeaders].reverse().find(([n]) => n === name);
    return found ? canonicalizeHeaderRelaxed(found[0]!, found[1]!) : null;
  }).filter((h): h is string => h !== null);

  // Include the (value-less) DKIM-Signature header itself as the last signed header
  toSign.push(canonicalizeHeaderRelaxed(sigHeaderName, sigHeaderValue));

  const dataToSign = toSign.join('');

  const signature = createSign('sha256')
    .update(dataToSign, 'binary')
    .sign(config.privateKey, 'base64');

  // Fold the signature value at 72 chars
  const foldedSig = foldBase64(signature);
  const finalHeader = `${sigHeaderName}: ${sigHeaderValue}${foldedSig}\r\n`;

  return Buffer.concat([Buffer.from(finalHeader, 'binary'), raw]);
}

// ── Parsing ────────────────────────────────────────────────────────────────────

function parseHeaders(block: string): [string, string][] {
  const result: [string, string][] = [];
  const lines = block.split('\r\n');
  let current: [string, string] | null = null;

  for (const line of lines) {
    if (line.length === 0) continue;
    // Continuation (folded header)
    if (line[0] === ' ' || line[0] === '\t') {
      if (current) current[1] += '\r\n' + line;
      continue;
    }
    if (current) result.push(current);
    const colon = line.indexOf(':');
    if (colon === -1) { current = null; continue; }
    current = [line.slice(0, colon).toLowerCase(), line.slice(colon + 1)];
  }
  if (current) result.push(current);
  return result;
}

// ── Relaxed canonicalization ───────────────────────────────────────────────────

function canonicalizeHeaderRelaxed(name: string, value: string): string {
  const lname = name.toLowerCase();
  // Unfold, collapse WSP, trim
  const lvalue = value
    .replace(/\r\n[ \t]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return `${lname}:${lvalue}\r\n`;
}

function canonicalizeBodyRelaxed(body: string): string {
  // Ensure CRLF line endings
  const normalized = body.replace(/\r\n|\r|\n/g, '\r\n');
  const lines = normalized.split('\r\n');

  const canon = lines.map(line =>
    // Reduce WSP runs to single SP, remove trailing WSP
    line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, ''),
  );

  // Remove trailing empty lines, leaving exactly one CRLF at end
  while (canon.length > 0 && canon[canon.length - 1] === '') canon.pop();
  canon.push('');  // RFC 6376 §3.4.4: body must end with CRLF

  return canon.join('\r\n');
}

function foldBase64(b64: string): string {
  // Insert CRLF + whitespace every 72 chars
  return b64.replace(/.{72}/g, '$&\r\n\t');
}
