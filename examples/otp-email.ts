/**
 * One-time-code emails that mail clients recognise ("Copy code" in Gmail, code AutoFill from
 * Mail on iOS/macOS, Outlook mobile).
 *
 * There is no markup for this: clients detect codes heuristically from the content. These
 * habits make detection reliable — and help users who read the email by hand:
 *   - the code in the subject, next to the word "code"
 *   - one code per email; no other long numbers (order ids, phone numbers) nearby
 *   - a plain-text part (mailts generates one from html automatically)
 *   - short, single-purpose message; say how long the code is valid
 *   - never put the code in a link or image
 *
 * Run:  SMTP_USER=you@gmail.com SMTP_PASS=<app password> npx tsx examples/otp-email.ts
 */
import { randomInt } from 'crypto';
import { MailTs } from '@mailts/core';
import type { EmailOptions } from '@mailts/core';

export function otpEmail(o: { to: string; from: string; product: string; code: string; minutes: number }): EmailOptions {
  const lines = [
    `Your ${o.product} verification code is ${o.code}`,
    `It expires in ${o.minutes} minutes. If you didn't ask for it, you can ignore this email.`,
  ];
  return {
    from: o.from,
    to: o.to,
    subject: `${o.code} is your ${o.product} verification code`,
    text: lines.join('\n\n'),
    html:
      `<p>Your ${o.product} verification code is</p>` +
      `<p style="font-size:28px;font-weight:bold;letter-spacing:4px;font-family:monospace">${o.code}</p>` +
      `<p>${lines[1]}</p>`,
  };
}

const me = process.env['SMTP_USER']!;
const mail = new MailTs({
  smtp: { host: 'smtp.gmail.com', port: 587, auth: { type: 'plain', user: me, pass: process.env['SMTP_PASS']! } },
});

const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); // crypto RNG, never Math.random
const r = await mail.send(otpEmail({ to: me, from: me, product: 'Acme', code, minutes: 10 }));
console.log(r.ok ? `sent ${code}` : r.error.message);
await mail.shutdown();
