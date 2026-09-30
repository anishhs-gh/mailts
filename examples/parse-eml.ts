/**
 * Parse raw email — .eml files, forwarded messages, or `session.fetchRaw(uid)`.
 *
 * parseMessage() handles multipart/alternative/related/mixed, RFC 2047 headers,
 * RFC 2231 filenames, address groups, charsets, and nested message/rfc822.
 *
 * Run:  npx tsx examples/parse-eml.ts [file.eml]
 */
import { readFile } from 'fs/promises';
import { buildMessage, parseMessage } from '../src/index.js';

// Use a file if given, otherwise build one to show the round-trip
const raw = process.argv[2]
  ? await readFile(process.argv[2])
  : (await buildMessage({
      from: 'Zoë <zoe@example.com>',
      to: ['Alice <alice@example.com>', 'bob@example.com'],
      subject: 'Q3 plan ☕',
      text: 'Plain version',
      html: '<p>HTML version <img src="cid:logo"></p>',
      references: ['<root@example.com>'],
      attachments: [
        { filename: 'Übersicht.pdf', content: Buffer.from('%PDF-1.7 demo') },
        { filename: 'logo.png', content: Buffer.from([137, 80, 78, 71]), cid: 'logo' },
      ],
    }, { attachmentPolicy: 'deny' })).raw;

const msg = parseMessage(raw);

console.log('Subject:   ', msg.envelope.subject);
console.log('From:      ', msg.envelope.from);
console.log('To:        ', msg.envelope.to);
console.log('Date:      ', msg.envelope.date?.toISOString());
console.log('References:', msg.references);
console.log('Text:      ', msg.text?.slice(0, 80));
console.log('HTML:      ', msg.html?.slice(0, 80));
for (const a of msg.attachments) {
  console.log(`Attachment: ${a.filename} (${a.contentType}, ${a.size} B${a.inline ? `, inline cid:${a.contentId}` : ''})`);
  if (a.nestedMessage) console.log('  forwarded message:', a.nestedMessage.envelope.subject);
}

// Any header is available too
console.log('Message-ID:', msg.headers.get('message-id'));

// From IMAP: const raw = await session.fetchRaw(uid); parseMessage(raw)
