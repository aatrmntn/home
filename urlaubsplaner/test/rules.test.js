import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../api/rules.js';

const FULL = r.FULL_WEEK;

test('Easter Sunday 2024–2030', () => {
  const expected = {
    2024: '2024-03-31', 2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28',
    2028: '2028-04-16', 2029: '2029-04-01', 2030: '2030-04-21',
  };
  for (const [y, d] of Object.entries(expected)) assert.equal(r.easterSunday(Number(y)), d);
});

test('Austrian public holidays 2026, complete list', () => {
  assert.deepEqual(r.publicHolidays(2026).map((h) => h.date), [
    '2026-01-01', '2026-01-06', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25',
    '2026-06-04', '2026-08-15', '2026-10-26', '2026-11-01', '2026-12-08', '2026-12-25',
    '2026-12-26',
  ]);
});

test('moving holidays 2024–2030 (Easter Monday, Ascension, Whit Monday, Corpus Christi)', () => {
  const expected = {
    2024: ['2024-04-01', '2024-05-09', '2024-05-20', '2024-05-30'],
    2025: ['2025-04-21', '2025-05-29', '2025-06-09', '2025-06-19'],
    2026: ['2026-04-06', '2026-05-14', '2026-05-25', '2026-06-04'],
    2027: ['2027-03-29', '2027-05-06', '2027-05-17', '2027-05-27'],
    2028: ['2028-04-17', '2028-05-25', '2028-06-05', '2028-06-15'],
    2029: ['2029-04-02', '2029-05-10', '2029-05-21', '2029-05-31'],
    2030: ['2030-04-22', '2030-05-30', '2030-06-10', '2030-06-20'],
  };
  for (const [y, dates] of Object.entries(expected)) {
    const names = ['Ostermontag', 'Christi Himmelfahrt', 'Pfingstmontag', 'Fronleichnam'];
    const got = names.map((n) => r.publicHolidays(Number(y)).find((h) => h.name === n).date);
    assert.deepEqual(got, dates, `year ${y}`);
  }
});

test('13 holidays every year; Good Friday, 24 and 31 Dec are working days', () => {
  for (let y = 2024; y <= 2030; y++) assert.equal(r.publicHolidays(y).length, 13);
  assert.equal(r.holidayName('2026-04-03'), ''); // Karfreitag
  assert.equal(r.holidayName('2026-12-24'), '');
  assert.equal(r.holidayName('2026-12-31'), '');
  assert.equal(r.holidayName('2026-10-26'), 'Nationalfeiertag');
});

test('date helpers', () => {
  assert.equal(r.isIsoDate('2026-02-29'), false);
  assert.equal(r.isIsoDate('2028-02-29'), true);
  assert.equal(r.isIsoDate('2026-1-5'), false);
  assert.equal(r.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(r.spanDays('2026-08-03', '2026-08-07'), 5);
  assert.equal(r.weekdayOf('2026-10-14'), 'wed');
  assert.equal(r.formatRange('2026-08-03', '2026-08-07'), '3. August bis 7. August 2026');
  assert.equal(r.formatDay('2027-01-04'), '4. Jänner 2027');
});

test('today is computed in Vienna, not UTC', () => {
  assert.equal(r.todayIn('Europe/Vienna', new Date('2026-10-14T22:30:00Z')), '2026-10-15');
  assert.equal(r.todayIn('Europe/Vienna', new Date('2026-12-31T22:59:00Z')), '2026-12-31');
  assert.equal(r.todayIn('Europe/Vienna', new Date('2026-12-31T23:00:00Z')), '2027-01-01');
});

test('counting: full week, part-time pattern, holiday, half day', () => {
  const week = { start: '2026-08-03', end: '2026-08-09' };
  assert.equal(r.countEntry(week, FULL).total, 5);
  assert.equal(r.countEntry(week, ['mon', 'tue', 'thu']).total, 3);
  // Thursday 14 May 2026 is Ascension
  assert.equal(r.countEntry({ start: '2026-05-11', end: '2026-05-15' }, FULL).total, 4);
  assert.equal(r.countEntry({ start: '2026-08-04', end: '2026-08-04', half: 'am' }, FULL).total, 0.5);
  assert.equal(r.countEntry({ start: '2026-08-08', end: '2026-08-09' }, FULL).total, 0);
});

test('counting: an entry over New Year is split per year', () => {
  const e = { start: '2026-12-28', end: '2027-01-08' };
  assert.deepEqual(r.countEntry(e, FULL), { total: 8, byYear: { 2026: 4, 2027: 4 } });
});

test('counting: closure days are not vacation days', () => {
  const closures = [{ kind: 'closure', status: 'approved', start: '2026-12-28', end: '2026-12-31' }];
  const closed = r.closureDays(closures);
  assert.equal(r.countEntry({ start: '2026-12-28', end: '2027-01-05' }, FULL, closed).total, 2);
  // a pending closure does not close anything
  const pending = r.closureDays([{ ...closures[0], status: 'pending' }]);
  assert.equal(pending.size, 0);
});

test('allowance: 25 days on 5 days, scaled for part-time, overrides win', () => {
  assert.equal(r.defaultAllowance(FULL), 25);
  assert.equal(r.defaultAllowance(['mon', 'tue', 'wed', 'thu']), 20);
  assert.equal(r.defaultAllowance(['mon', 'tue', 'thu']), 15);
  assert.equal(r.defaultAllowance(['mon']), 5);
  assert.equal(r.allowanceFor({ workPattern: FULL, allowances: { 2026: 27.5 } }, 2026), 27.5);
  assert.equal(r.allowanceFor({ workPattern: FULL, allowances: { 2025: 30 } }, 2026), 25);
});

// Shapes taken from the practice's own spreadsheet (names left out).
const xmas = ['2024-12-24', '2024-12-31', '2025-12-24', '2025-12-31', '2026-12-24']
  .map((d) => ({ kind: 'closure', status: 'approved', start: d, end: d }));
const vac = (list, status = 'approved') => list.map(([start, end = start]) => ({ kind: 'vacation', status, start, end }));

test('leave year runs from the start date; 29 February rolls to 28 February', () => {
  assert.deepEqual(r.leaveYearOf('2024-05-02', '2026-10-14'), { start: '2026-05-02', end: '2027-05-01' });
  assert.deepEqual(r.leaveYearOf('2024-05-02', '2026-05-01'), { start: '2025-05-02', end: '2026-05-01' });
  assert.deepEqual(r.leaveYearOf('2024-05-02', '2024-05-02'), { start: '2024-05-02', end: '2025-05-01' });
  assert.equal(r.addYears('2024-02-29', 1), '2025-02-28');
  assert.equal(r.leaveAnchor({}), '2026-01-01');
});

test('account over three leave years matches the spreadsheet', () => {
  const person = { workPattern: FULL, startDate: '2024-05-02' };
  const entries = vac([
    ['2024-08-05'], ['2024-12-27', '2025-01-09'], ['2025-02-07'], ['2025-03-31', '2025-04-01'], ['2025-06-20'],
    ['2025-06-10', '2025-06-13'], ['2025-09-15', '2025-09-26'], ['2025-11-17', '2025-11-19'], ['2026-04-22', '2026-04-30'],
    ['2026-08-25', '2026-08-28'], ['2026-10-30'], ['2027-01-19', '2027-02-11'],
  ]);
  const b = r.balance({ person, today: '2026-10-14', entries, closures: xmas });
  assert.deepEqual(b, {
    startDate: '2024-05-02', yearStart: '2026-05-02', yearEnd: '2027-05-01',
    allowance: 25, carryOver: 14, total: 39, taken: 4, planned: 19, pending: 0, remaining: 16,
    expired: 0, expiring: null,
  });
});

test('account: part-time pattern, correction for a short first period, pending separate', () => {
  const sophie = { workPattern: ['mon', 'tue', 'wed', 'thu'], startDate: '2026-03-09' };
  const entries = vac([['2026-10-05', '2026-10-08'], ['2026-12-07'], ['2026-12-09', '2026-12-10'], ['2027-01-07'], ['2027-01-18', '2027-01-19'], ['2027-02-04', '2027-02-15']]);
  const b = r.balance({ person: sophie, today: '2026-10-14', entries, closures: xmas });
  assert.equal(b.allowance, 20);
  assert.equal(b.taken, 4);
  assert.equal(b.planned, 12);
  assert.equal(b.remaining, 4);
  const vero = { workPattern: FULL, startDate: '2026-06-01', extraDays: 1 };
  const v = r.balance({ person: vero, today: '2026-10-14', entries: [...vac([['2026-06-30', '2026-07-03'], ['2026-09-21', '2026-09-25']]), ...vac([['2026-11-02']], 'pending')] });
  assert.equal(v.total, 26);
  assert.equal(v.remaining, 17);
  assert.equal(v.pending, 1);
});

test('account: unused days expire two years after the end of their leave year, oldest used first', () => {
  const person = { workPattern: FULL, startDate: '2024-01-01' };
  const entries = vac([['2024-03-04', '2024-03-08']]); // 5 of 25 used in the first year
  const before = r.balance({ person, today: '2026-12-31', entries });
  assert.equal(before.expired, 0);
  assert.deepEqual(before.expiring, { date: '2026-12-31', days: 20 });
  assert.equal(before.remaining, 70);
  const after = r.balance({ person, today: '2027-01-01', entries });
  assert.equal(after.expired, 20, 'the 20 left from 2024 are gone on 1 January 2027');
  assert.equal(after.remaining, 75, '25 + 25 + 25 + 25 earned, 5 used, 20 expired');
  // using days in 2026 takes them from 2024 first, so nothing of 2024 expires
  // 20 working days in June 2026 (4 June is Corpus Christi)
  const used = r.balance({ person, today: '2027-01-01', entries: [...entries, ...vac([['2026-06-01', '2026-06-29']])] });
  assert.equal(used.expired, 0);
  assert.equal(used.remaining, 75);
});

test('account: closures that count as vacation cost each person their own working days', () => {
  const person = { workPattern: ['mon', 'tue', 'thu'], startDate: '2026-01-01' };
  const closures = [{ kind: 'closure', status: 'approved', countsAsVacation: true, start: '2026-12-28', end: '2027-01-01' }];
  const b = r.balance({ person, today: '2026-10-14', closures });
  assert.equal(b.allowance, 15);
  assert.equal(b.planned, 3); // Mon 28, Tue 29, Thu 31
  assert.equal(b.remaining, 12);
});

test('snapshot: deleting old entries after a snapshot leaves every balance unchanged', () => {
  const person = { workPattern: FULL, startDate: '2024-05-02' };
  const entries = vac([['2024-08-05'], ['2024-12-27', '2025-01-09'], ['2025-02-07'], ['2025-09-15', '2025-09-26'], ['2026-04-22', '2026-04-30'], ['2027-01-19', '2027-02-11']]);
  for (const cutoff of ['2025-01-01', '2026-01-01', '2026-05-02']) {
    const snapshot = r.snapshotAt({ person, cutoff, entries, closures: xmas });
    const kept = entries.filter((e) => e.end >= cutoff);
    const keptClosures = xmas.filter((c) => c.end >= cutoff);
    for (const today of ['2026-10-14', '2027-06-01', '2028-05-02']) {
      const full = r.balance({ person, today, entries, closures: xmas });
      const compact = r.balance({ person: { ...person, snapshot }, today, entries: kept, closures: keptClosures });
      assert.equal(compact.remaining, full.remaining, `cutoff ${cutoff}, today ${today}`);
      assert.equal(compact.expired, full.expired, `expired, cutoff ${cutoff}, today ${today}`);
    }
  }
});

test('validation: dates, span, half days, note', () => {
  const v = (x) => r.validateEntry({ kind: 'vacation', ...x }).error;
  assert.match(v({ start: 'morgen' }), /gültiges Startdatum/);
  assert.match(v({ start: '2026-08-07', end: '2026-08-03' }), /vor dem Startdatum/);
  assert.match(v({ start: '2019-12-30', end: '2020-01-03' }), /zwischen 2020 und 2040/);
  assert.match(v({ start: '2040-12-31', end: '2041-01-02' }), /zwischen 2020 und 2040/);
  assert.match(v({ start: '2026-06-01', end: '2026-09-01' }), /höchstens 92 Tage/);
  assert.equal(v({ start: '2026-06-01', end: '2026-08-31' }), undefined);
  assert.match(v({ start: '2026-08-03', end: '2026-08-04', half: 'am' }), /selben Datum/);
  assert.match(v({ start: '2026-08-03', half: 'evening' }), /Vormittag oder Nachmittag/);
  assert.match(v({ start: '2026-08-03', note: 'x'.repeat(301) }), /300 Zeichen/);
  assert.match(r.validateEntry({ kind: 'sick', start: '2026-08-03' }).error, /Urlaub oder/);
  assert.match(r.validateEntry({ kind: 'absence', start: '2026-08-03' }).error, /Grund/);
});

test('validation: end defaults to start, text is trimmed', () => {
  const { value } = r.validateEntry({ kind: 'absence', reason: 'training', start: '2026-08-08', note: '  Kurs ' });
  assert.deepEqual(value, {
    kind: 'absence', reason: 'training', start: '2026-08-08', end: '2026-08-08', half: '', note: 'Kurs',
  });
});

test('validation: vacation only on free days has nothing to book', () => {
  const err = r.validateEntry({ kind: 'vacation', start: '2026-08-08', end: '2026-08-09' }).error;
  assert.match(err, /nichts zu buchen/);
  assert.match(r.validateEntry({ kind: 'vacation', start: '2026-12-25' }).error, /nichts zu buchen/);
  assert.match(
    r.validateEntry({ kind: 'vacation', start: '2026-08-05' }, { pattern: ['mon', 'tue', 'thu'] }).error,
    /nichts zu buchen/,
  );
  // other absences may sit on a free day
  assert.equal(r.validateEntry({ kind: 'absence', reason: 'training', start: '2026-08-08' }).error, undefined);
});

test('validation: no overlap with own entries, except morning + afternoon', () => {
  const existing = [
    { id: 'a', status: 'approved', start: '2026-08-03', end: '2026-08-07', half: '' },
    { id: 'b', status: 'pending', start: '2026-09-01', end: '2026-09-01', half: 'am' },
    { id: 'c', status: 'declined', start: '2026-10-05', end: '2026-10-09', half: '' },
  ];
  const v = (x, id) => r.validateEntry({ kind: 'vacation', ...x }, { existing, id }).error;
  assert.match(v({ start: '2026-08-07', end: '2026-08-10' }), /vom 3\. August bis 7\. August 2026/);
  assert.equal(v({ start: '2026-09-01', half: 'pm' }), undefined);
  assert.match(v({ start: '2026-09-01', half: 'am' }), /am 1\. September 2026 \(Vormittag\)/);
  assert.match(v({ start: '2026-09-01' }), /überschneidet/);
  assert.equal(v({ start: '2026-10-05' }), undefined, 'declined entries do not block');
  assert.equal(v({ start: '2026-08-04', end: '2026-08-06' }, 'a'), undefined, 'editing itself is fine');
});

test('validation: names', () => {
  assert.equal(r.validateName('  Anna ').value, 'Anna');
  assert.match(r.validateName('').error, /Namen/);
  assert.match(r.validateName('x'.repeat(81)).error, /80 Zeichen/);
});
