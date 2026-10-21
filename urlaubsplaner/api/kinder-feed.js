// The children's calendar (e.g. a published iCloud or Google calendar): read its .ics,
// keep only the days the children are free (holidays, closures, "kein Unterricht"),
// and sort them into school and kindergarten by words in the title.
// Nothing here talks to the network; app.js passes the downloaded text in.
import { addDays, isIsoDate, TIME_ZONE } from './rules.js';

export const DEFAULT_WORDS = {
  free: 'ferien, break, kein unterricht, no school, schulfrei, geschlossen, bridge day, pd day, fenstertag, autonom',
  kindergarten: 'kindergarten, kiga, krippe',
};

export const splitWords = (text) => String(text || '').split(',').map((w) => w.trim().toLocaleLowerCase('de')).filter(Boolean);

// webcal:// links (iCloud, Outlook) are plain https.
export function normalizeFeedUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { value: '' };
  const url = raw.replace(/^webcals?:\/\//i, 'https://');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'Der Kalender-Link sieht nicht richtig aus. Er beginnt mit webcal:// oder https://.' };
  }
  if (parsed.protocol !== 'https:' || /^[\d.]+$|^\[/.test(parsed.hostname) || parsed.hostname === 'localhost') {
    return { error: 'Bitte einen öffentlichen Kalender-Link mit webcal:// oder https:// verwenden.' };
  }
  if (url.length > 1000) return { error: 'Der Kalender-Link ist zu lang.' };
  return { value: url };
}

// Lines of an .ics file with folded lines joined again (RFC 5545, 3.1).
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescape(value) {
  return value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

// "20261019", "20261019T080000", "20261019T080000Z" → ISO day in Vienna.
function dayOf(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (z) {
    const at = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss));
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }
  const iso = `${y}-${mo}-${d}`;
  return isIsoDate(iso) ? { iso, timed: !!hh, midnight: hh === '00' && mi === '00' } : null;
}

// All events: [{ uid, summary, start, end }] with inclusive ISO days.
export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur?.start && !cur.cancelled) {
        const start = cur.start.iso;
        let end = cur.end ? cur.end.iso : start;
        // All-day events and events ending at midnight end the day before.
        if (cur.end && (!cur.end.timed || cur.end.midnight) && end > start) end = addDays(end, -1);
        if (end < start) end = start;
        events.push({ uid: cur.uid || '', summary: cur.summary || '', start, end });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    const key = name.toUpperCase();
    if (key === 'SUMMARY') cur.summary = unescape(value);
    else if (key === 'UID') cur.uid = value.trim();
    else if (key === 'STATUS' && value.trim().toUpperCase() === 'CANCELLED') cur.cancelled = true;
    else if (key === 'DTSTART' || key === 'DTEND') {
      const d = dayOf(value, params);
      const day = typeof d === 'string' ? { iso: d, timed: true, midnight: false } : d;
      if (day) cur[key === 'DTSTART' ? 'start' : 'end'] = day;
    }
  }
  return events;
}

// The children's free days from the calendar, as holiday items like the manual ones.
// words: { free, kindergarten } as comma separated text. Free days without a
// kindergarten word count as school holidays.
export function freeDaysFromIcs(text, words = DEFAULT_WORDS) {
  const free = splitWords(words.free ?? DEFAULT_WORDS.free);
  const kiga = splitWords(words.kindergarten ?? DEFAULT_WORDS.kindergarten);
  const has = (title, list) => list.some((w) => title.includes(w));
  const items = [];
  for (const e of parseIcs(text)) {
    const title = e.summary.toLocaleLowerCase('de');
    if (!has(title, free)) continue;
    items.push({
      id: `kalender-${e.uid || e.summary}-${e.start}`.slice(0, 200),
      kind: has(title, kiga) ? 'kindergarten' : 'school',
      label: e.summary.slice(0, 80),
      start: e.start,
      end: e.end,
      soft: false, // no leave while the children are free, summer included
      fromCalendar: true,
    });
  }
  return items.sort((a, b) => a.start.localeCompare(b.start));
}
