// iCalendar (RFC 5545) for downloads and the calendar subscription.
// CRLF line endings, lines folded at 75 octets, VTIMEZONE for Europe/Vienna.
// Events are "free/transparent" so they never block anyone's calendar.
import { addDays } from './rules.js';

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Vienna',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

const HALF_TIMES = { am: ['080000', '120000'], pm: ['130000', '170000'] };

export function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Splits a line into chunks of at most 75 octets without cutting a UTF-8 character.
export function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > limit) {
      out.push(current);
      current = ' ';
      bytes = 1;
      limit = 75;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

const compact = (iso) => iso.replace(/-/g, '');
const stamp = (isoTime) => `${isoTime.replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15)}Z`;

// events: [{ uid, start, end, half, summary, description, updatedAt }]
export function calendar({ name, events }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NW7//Urlaubsplaner//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Europe/Vienna',
    ...VTIMEZONE,
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp(e.updatedAt)}`);
    if (e.half && HALF_TIMES[e.half]) {
      const [from, to] = HALF_TIMES[e.half];
      lines.push(`DTSTART;TZID=Europe/Vienna:${compact(e.start)}T${from}`, `DTEND;TZID=Europe/Vienna:${compact(e.start)}T${to}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compact(e.start)}`, `DTEND;VALUE=DATE:${compact(addDays(e.end, 1))}`);
    }
    lines.push(`SUMMARY:${escapeText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
