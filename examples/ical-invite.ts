/**
 * Calendar invite (iCal) — attach a .ics file to an email.
 *
 * The recipient's mail client recognises the text/calendar MIME part and
 * offers an "Add to Calendar" button directly in the email.
 *
 * Run:  SMTP_PASS=<pass> npx tsx examples/ical-invite.ts
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'iamska786@gmail.com', pass: 'yzfy kofb lbtw ilrb' },
  },
  logger: { level: 'info', format: 'pretty' },
});

// ── Single-day meeting ────────────────────────────────────────────────────────
const result1 = await mail.send({
  from: { email: 'iamska786@gmail.com', name: 'Example Team' },
  to: ['anishsh701@gmail.com'],
  subject: 'Team sync — Thursday 9 AM',
  text: 'You are invited to our weekly team sync.',
  html: '<p>You are invited to our weekly <strong>team sync</strong>.</p>',
  ical: {
    uid: 'team-sync-2026-04-30@example.com',
    summary: 'Weekly Team Sync',
    description: 'Discuss roadmap updates and blockers.',
    location: 'https://meet.example.com/team-sync',
    // Local Date constructor — wall-clock values are treated as the specified timezone.
    start: new Date(2026, 3, 30, 9, 0, 0),   // 9:00 AM
    end:   new Date(2026, 3, 30, 9, 30, 0),  // 9:30 AM
    // Auto-detect the system timezone so recipients see the correct local equivalent.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    organizer: { name: 'Example Team', email: 'calendar@example.com' },
    attendees: [
      { name: 'Alice', email: 'alice@example.com', rsvp: true },
      { name: 'Bob',   email: 'bob@example.com',   rsvp: true },
    ],
    method: 'REQUEST',   // REQUEST = new/updated invite; CANCEL = cancellation
    status: 'CONFIRMED',
  },
});
console.log('Meeting invite:', result1.ok ? result1.messageId : result1.error.message);

// ── Cancellation ──────────────────────────────────────────────────────────────
const result2 = await mail.send({
  from: { email: 'iamska786@gmail.com', name: 'Example Team' },
  to: ['anishsh701@gmail.com'],
  subject: 'Cancelled: Team sync — Thursday 9 AM',
  text: 'The team sync has been cancelled.',
  ical: {
    uid: 'team-sync-2026-04-30@example.com',   // same UID as the original invite
    summary: 'Weekly Team Sync',
    start: new Date(2026, 3, 30, 9, 0, 0),
    end:   new Date(2026, 3, 30, 9, 30, 0),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    organizer: { name: 'Example Team', email: 'calendar@example.com' },
    method: 'CANCEL',
    status: 'CANCELLED',
  },
});
console.log('Cancellation:', result2.ok ? result2.messageId : result2.error.message);

await mail.shutdown();
