import { describe, it, expect } from 'vitest';
import { buildICalString } from '../../../src/core/ICal.js';
import type { ICalEvent } from '../../../src/core/ICal.js';

const BASE_EVENT: ICalEvent = {
  summary: 'Team Meeting',
  start: new Date('2024-06-01T14:00:00Z'),
  end: new Date('2024-06-01T15:00:00Z'),
  organizer: { name: 'Alice', email: 'alice@example.com' },
};

describe('buildICalString', () => {
  it('produces valid VCALENDAR structure', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('BEGIN:VCALENDAR');
    expect(cal).toContain('END:VCALENDAR');
    expect(cal).toContain('BEGIN:VEVENT');
    expect(cal).toContain('END:VEVENT');
  });

  it('includes required iCal headers', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('VERSION:2.0');
    expect(cal).toContain('PRODID:-//mailts//mailts//EN');
    expect(cal).toContain('METHOD:REQUEST');
  });

  it('formats DTSTART and DTEND in UTC', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('DTSTART:20240601T140000Z');
    expect(cal).toContain('DTEND:20240601T150000Z');
  });

  it('includes SUMMARY', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('SUMMARY:Team Meeting');
  });

  it('includes ORGANIZER', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('ORGANIZER;CN=Alice:mailto:alice@example.com');
  });

  it('uses default method REQUEST', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('METHOD:REQUEST');
  });

  it('uses specified method', () => {
    const cal = buildICalString({ ...BASE_EVENT, method: 'CANCEL' });
    expect(cal).toContain('METHOD:CANCEL');
  });

  it('includes DESCRIPTION when provided', () => {
    const cal = buildICalString({ ...BASE_EVENT, description: 'Quarterly review' });
    expect(cal).toContain('DESCRIPTION:Quarterly review');
  });

  it('includes LOCATION when provided', () => {
    const cal = buildICalString({ ...BASE_EVENT, location: 'Conference Room B' });
    expect(cal).toContain('LOCATION:Conference Room B');
  });

  it('uses provided UID', () => {
    const cal = buildICalString({ ...BASE_EVENT, uid: 'fixed-uid-123@test' });
    expect(cal).toContain('UID:fixed-uid-123@test');
  });

  it('auto-generates a UID when not provided', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toMatch(/UID:[a-f0-9]+@mailts/);
  });

  it('generates different UIDs for separate calls', () => {
    const cal1 = buildICalString(BASE_EVENT);
    const cal2 = buildICalString(BASE_EVENT);
    const uid1 = cal1.match(/UID:([^\r\n]+)/)?.[1];
    const uid2 = cal2.match(/UID:([^\r\n]+)/)?.[1];
    expect(uid1).not.toBe(uid2);
  });

  it('includes SEQUENCE', () => {
    const cal = buildICalString({ ...BASE_EVENT, sequence: 2 });
    expect(cal).toContain('SEQUENCE:2');
  });

  it('defaults SEQUENCE to 0', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('SEQUENCE:0');
  });

  it('defaults STATUS to CONFIRMED', () => {
    const cal = buildICalString(BASE_EVENT);
    expect(cal).toContain('STATUS:CONFIRMED');
  });

  it('uses specified STATUS', () => {
    const cal = buildICalString({ ...BASE_EVENT, status: 'TENTATIVE' });
    expect(cal).toContain('STATUS:TENTATIVE');
  });

  it('includes attendees', () => {
    const cal = buildICalString({
      ...BASE_EVENT,
      attendees: [
        { email: 'bob@example.com', name: 'Bob', rsvp: true },
        { email: 'carol@example.com', rsvp: false },
      ],
    });
    expect(cal).toContain('mailto:bob@example.com');
    expect(cal).toContain('RSVP=TRUE');
    expect(cal).toContain('mailto:carol@example.com');
    expect(cal).toContain('RSVP=FALSE');
  });

  it('defaults attendee role to REQ-PARTICIPANT', () => {
    const cal = buildICalString({
      ...BASE_EVENT,
      attendees: [{ email: 'bob@example.com' }],
    });
    expect(cal).toContain('ROLE=REQ-PARTICIPANT');
  });

  it('uses specified attendee role', () => {
    const cal = buildICalString({
      ...BASE_EVENT,
      attendees: [{ email: 'bob@example.com', role: 'OPT-PARTICIPANT' }],
    });
    expect(cal).toContain('ROLE=OPT-PARTICIPANT');
  });

  it('escapes semicolons in summary', () => {
    const cal = buildICalString({ ...BASE_EVENT, summary: 'A; B; C' });
    expect(cal).toContain('SUMMARY:A\\; B\\; C');
  });

  it('escapes commas in description', () => {
    const cal = buildICalString({ ...BASE_EVENT, description: 'A, B, C' });
    expect(cal).toContain('DESCRIPTION:A\\, B\\, C');
  });

  it('escapes newlines in description', () => {
    const cal = buildICalString({ ...BASE_EVENT, description: 'Line 1\nLine 2' });
    expect(cal).toContain('DESCRIPTION:Line 1\\nLine 2');
  });

  it('uses CRLF line endings throughout', () => {
    const cal = buildICalString(BASE_EVENT);
    // All lines end with \r\n
    const lines = cal.split('\r\n');
    expect(lines.length).toBeGreaterThan(5);
    // No bare LF
    expect(cal.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('folds lines longer than 75 octets', () => {
    const longSummary = 'A'.repeat(100);
    const cal = buildICalString({ ...BASE_EVENT, summary: longSummary });
    const lines = cal.split('\r\n');
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  it('handles timezone parameter', () => {
    const cal = buildICalString({ ...BASE_EVENT, timezone: 'America/New_York' });
    expect(cal).toContain('TZID=America/New_York');
    // Local time (no trailing Z)
    expect(cal).toMatch(/DTSTART;TZID=America\/New_York:\d{8}T\d{6}$/m);
  });
});
