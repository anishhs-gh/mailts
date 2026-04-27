import { randomBytes } from 'crypto';

export type ICalMethod = 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH';
export type ICalStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
export type ICalAttendeeRole = 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT' | 'NON-PARTICIPANT' | 'CHAIR';

export interface ICalAttendee {
  email: string;
  name?: string;
  rsvp?: boolean;
  role?: ICalAttendeeRole;
}

export interface ICalEvent {
  /** iCal method. @default 'REQUEST' */
  method?: ICalMethod;
  /** Event title. */
  summary: string;
  /** Optional description body. */
  description?: string;
  /** Optional location string. */
  location?: string;
  /** Event start time. Construct with `new Date(year, month, day, h, m, s)` so the
   *  wall-clock value matches the `timezone` you specify. Leave `timezone` unset to
   *  emit a UTC timestamp (`DTSTART:...Z`) instead. */
  start: Date;
  /** Event end time. Same timezone convention as `start`. */
  end: Date;
  /** Organizer — name and email. */
  organizer: { name: string; email: string };
  /** Attendees to invite. */
  attendees?: ICalAttendee[];
  /** Stable UID for this event — auto-generated if omitted. */
  uid?: string;
  /** Sequence number for updates. @default 0 */
  sequence?: number;
  /** Event status. @default 'CONFIRMED' */
  status?: ICalStatus;
  /** Timezone identifier (e.g. `America/New_York`). @default 'UTC' */
  timezone?: string;
}

/**
 * Generates a RFC 5545 iCalendar string.
 * Attach the result as a `text/calendar` MIME part — `buildICalAttachment()` does this.
 */
export function buildICalString(event: ICalEvent): string {
  const method = event.method ?? 'REQUEST';
  const uid = event.uid ?? `${randomBytes(16).toString('hex')}@mailts`;
  const sequence = event.sequence ?? 0;
  const status = event.status ?? 'CONFIRMED';
  const tz = event.timezone ?? 'UTC';

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mailts//mailts//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART${tz !== 'UTC' ? `;TZID=${tz}` : ''}:${formatDate(event.start, tz)}`,
    `DTEND${tz !== 'UTC' ? `;TZID=${tz}` : ''}:${formatDate(event.end, tz)}`,
    `DTSTAMP:${formatDate(new Date(), 'UTC')}`,
    `SUMMARY:${escapeIcal(event.summary)}`,
    `SEQUENCE:${sequence}`,
    `STATUS:${status}`,
    `ORGANIZER;CN=${escapeIcal(event.organizer.name)}:mailto:${event.organizer.email}`,
  ];

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcal(event.description)}`);
  }

  if (event.location) {
    lines.push(`LOCATION:${escapeIcal(event.location)}`);
  }

  for (const att of event.attendees ?? []) {
    const role = att.role ?? 'REQ-PARTICIPANT';
    const rsvp = att.rsvp !== false ? 'TRUE' : 'FALSE';
    const cn = att.name ? `;CN=${escapeIcal(att.name)}` : '';
    lines.push(`ATTENDEE;ROLE=${role};RSVP=${rsvp}${cn}:mailto:${att.email}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // RFC 5545 §3.1: fold lines longer than 75 octets
  return lines.map(foldIcalLine).join('\r\n') + '\r\n';
}

function formatDate(d: Date, tz: string): string {
  if (tz === 'UTC') {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  }
  // Wall-clock semantics: the Date's local values ARE the intended time in the specified timezone.
  // Use local accessors so that new Date(year, month, day, hour, ...) always round-trips correctly
  // regardless of the machine's system timezone.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function escapeIcal(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function foldIcalLine(line: string): string {
  // RFC 5545 §3.1 — fold at 75 octets, continuation line starts with a single space
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let offset = 0;
  let first = true;

  while (offset < bytes.length) {
    const limit = first ? 75 : 74; // 74 + leading space = 75
    let end = offset + limit;
    if (end >= bytes.length) { end = bytes.length; }
    else {
      // Don't split multi-byte UTF-8 sequences
      while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
    }
    parts.push((first ? '' : ' ') + bytes.subarray(offset, end).toString('utf8'));
    offset = end;
    first = false;
  }

  return parts.join('\r\n');
}
