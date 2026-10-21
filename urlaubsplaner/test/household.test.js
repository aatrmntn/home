// NW7: the household version. Parents approve, the assistant enters for everyone,
// household staff have no login. School holidays, blocked times, rest days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import * as r from '../api/rules.js';
import { freeDaysFromIcs, normalizeFeedUrl, parseIcs } from '../api/kinder-feed.js';
import { createMemoryDb } from '../dev/memory-db.js';

const FULL = r.FULL_WEEK;
// Made-up names.
const people = [
  { userId: 'lea', username: 'lea', name: 'Lea', role: 'family', active: true, approver: true, workPattern: FULL, email: 'lea@example.at' },
  { userId: 'tom', username: 'tom', name: 'Tom', role: 'family', active: true, approver: true, workPattern: FULL },
  { userId: 'eva', username: 'eva', name: 'Eva', role: 'office', active: true, planner: true, workPattern: FULL },
  { userId: 'ohne-zugang-petra', username: '', name: 'Petra', role: 'household', job: 'Reinigung', active: true, login: false, sperrzeiten: true, workPattern: FULL, startDate: '2025-10-30' },
  { userId: 'ohne-zugang-karl', username: '', name: 'Karl', role: 'household', job: 'Garten', active: true, login: false, workPattern: FULL, startDate: '2026-03-25' },
];
const LEA = { id: 'lea', groups: ['approver'] };
const EVA = { id: 'eva', groups: ['planner'] };
const PETRA = 'ohne-zugang-petra';
const KARL = 'ohne-zugang-karl';

let n = 0;
const entry = (userId, start, end = start, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  userId, kind: 'vacation', reason: '', start, end, half: '', note: '', status: 'approved', rev: 1,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

function setup({ entries = [], now = '2026-10-21T08:00:00Z', ferien = [], fetchText } = {}) {
  const db = createMemoryDb({ people, entries, settings: { ferien } });
  const calls = [];
  const directory = {
    async createUser(args) { calls.push(['create', args]); return { userId: 'new-login', startPassword: 'Start-Passwort-1' }; },
    async setEnabled(...args) { calls.push(['enabled', ...args]); },
    async setGroup(...args) { calls.push(['group', ...args]); },
  };
  const app = createApp({ db, now: () => new Date(now), directory, ...(fetchText ? { fetchText } : {}) });
  const call = (user, method, path, body, query = {}) => app.handle({ method, path, body, query, user });
  return { db, call, calls };
}

const HERBST = { id: 'f1', kind: 'school', label: 'Herbstferien', start: '2026-10-26', end: '2026-11-02' };
const SOMMER = { id: 'f2', kind: 'school', label: 'Sommerferien', start: '2027-07-03', end: '2027-09-05', soft: true };

// ---------- roles ----------

test('assistant enters for staff (pending), sees requests, but cannot approve', async () => {
  const { call } = setup();
  const res = await call(EVA, 'POST', '/api/entries', { userId: KARL, kind: 'vacation', start: '2026-11-16', end: '2026-11-20', approved: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.item.status, 'pending', '"schon genehmigt" is for approvers only');
  const inbox = (await call(EVA, 'GET', '/api/requests')).body.item;
  assert.equal(inbox.requests.length, 1);
  assert.equal(inbox.requests[0].canDecide, false);
  assert.equal(inbox.canApprove, false);
  const decide = await call(EVA, 'POST', `/api/entries/${res.body.item.id}/decision`, { status: 'approved', expectedRev: 1 });
  assert.equal(decide.status, 403);
  const ok = await call(LEA, 'POST', `/api/entries/${res.body.item.id}/decision`, { status: 'approved', expectedRev: 1 });
  assert.equal(ok.body.item.status, 'approved');
});

test('assistant can open anyone\'s calendar; family members without rights cannot', async () => {
  const { call } = setup();
  const o = (await call(EVA, 'GET', '/api/overview', undefined, { userId: KARL })).body.item;
  assert.equal(o.subject.name, 'Karl');
  assert.equal(o.subject.job, 'Garten');
  assert.ok(o.people.some((p) => p.userId === PETRA));
  assert.ok(!o.people.some((p) => p.role === 'office'), 'the assistant is not someone to plan for');
  const plain = { id: 'tom', groups: ['staff'] };
  assert.equal((await call(plain, 'GET', '/api/overview', undefined, { userId: KARL })).status, 403);
});

test('the family\'s own holiday is approved at once', async () => {
  const { call } = setup();
  const res = await call(EVA, 'POST', '/api/entries', { userId: 'tom', kind: 'vacation', start: '2026-12-21', end: '2026-12-31' });
  assert.equal(res.body.item.status, 'approved');
});

// ---------- people without login ----------

test('people: the assistant adds staff without login; logins only by approvers', async () => {
  const { call, calls, db } = setup();
  const res = await call(EVA, 'POST', '/api/people', { login: false, name: 'Nina', role: 'household', job: 'Nanny', workPattern: FULL, startDate: '2025-11-10' });
  assert.equal(res.status, 201);
  assert.equal(res.body.item.startPassword, '');
  assert.match(res.body.item.person.userId, /^ohne-zugang-/);
  assert.equal(res.body.item.person.login, false);
  assert.equal(calls.length, 0, 'no login created');
  assert.equal((await db.getPerson(res.body.item.person.userId)).job, 'Nanny');
  const login = await call(EVA, 'POST', '/api/people', { username: 'nina2', name: 'Nina', role: 'household', workPattern: FULL });
  assert.equal(login.status, 403);
  const byLea = await call(LEA, 'POST', '/api/people', { username: 'eva2', name: 'Eva 2', role: 'office', planner: true, workPattern: FULL });
  assert.equal(byLea.status, 201);
  assert.deepEqual(calls[0], ['create', { username: 'eva2', email: '', group: 'planner' }]);
});

test('people: rights can only be given to people with a login; group changes go to the login system', async () => {
  const { call, calls } = setup();
  assert.equal((await call(LEA, 'PUT', `/api/people/${KARL}`, { approver: true })).status, 400);
  assert.equal((await call(EVA, 'PUT', '/api/people/tom', { planner: true })).status, 403, 'only approvers change rights');
  await call(LEA, 'PUT', '/api/people/eva', { approver: true });
  assert.deepEqual(calls, [['group', 'eva', 'approver', 'planner']]);
});

// ---------- rest days ----------

test('rest days: account starts on the given date; next allowance at the anniversary', async () => {
  const { call } = setup();
  const res = await call(EVA, 'PUT', `/api/people/${PETRA}`, { restDays: 25, restAsOf: '2026-10-20' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.item.rest, { days: 25, asOf: '2026-10-20' });
  assert.equal(res.body.item.balance.remaining, 25);
  assert.equal(res.body.item.balance.allowance, 25);

  // after the anniversary on 30 October, the new year's 25 days are added
  const later = setup({ now: '2026-11-03T08:00:00Z' });
  await later.call(EVA, 'PUT', `/api/people/${PETRA}`, { restDays: 25, restAsOf: '2026-10-20' });
  const o = (await later.call(EVA, 'GET', '/api/overview', undefined, { userId: PETRA })).body.item;
  assert.equal(o.balance.yearStart, '2026-10-30');
  assert.equal(o.balance.total, 50);
  assert.equal(o.balance.carryOver, 25);

  // without a start date there is no rest
  const noStart = { ...people[4], startDate: undefined };
  assert.match(r.validatePersonUpdate({ restDays: 3, restAsOf: '2026-10-20' }, noStart).error, /Eintrittsdatum/);
  // removing the rest goes back to the normal account
  const cleared = r.validatePersonUpdate({ restDays: null }, (await call(EVA, 'GET', '/api/people')).body.item.people.find((p) => p.userId === PETRA));
  assert.equal(cleared.value.rest, undefined);
});

test('rest days: days taken after the date count against the rest', () => {
  const person = { userId: 'k', workPattern: FULL, startDate: '2026-03-25' };
  person.snapshot = r.restSnapshot(person, 24, '2026-10-20');
  const entries = [entry('k', '2026-11-02', '2026-11-06'), entry('k', '2026-10-12', '2026-10-16')];
  const b = r.balance({ person, today: '2026-10-21', entries });
  assert.equal(b.total, 24);
  assert.equal(b.planned, 5);
  assert.equal(b.remaining, 19, 'the week before the date is already in the rest');
});

// ---------- school holidays ----------

test('holidays: assistant and approvers keep the list; staff cannot', async () => {
  const { call, db } = setup();
  const staff = { id: 'x', groups: ['staff'] };
  const body = { kind: 'kindergarten', label: 'Kindergarten zu', start: '2026-12-21', end: '2027-01-08' };
  assert.equal((await call(staff, 'POST', '/api/ferien', body)).status, 403);
  assert.equal((await call(EVA, 'POST', '/api/ferien', { ...body, kind: 'uni' })).status, 400);
  const res = await call(EVA, 'POST', '/api/ferien', body);
  assert.equal(res.status, 201);
  const put = await call(LEA, 'PUT', `/api/ferien/${res.body.item.id}`, { ...body, end: '2027-01-06' });
  assert.equal(put.body.item.end, '2027-01-06');
  // saving the settings keeps the holidays
  await call(LEA, 'PUT', '/api/settings', { practiceName: 'NW7' });
  assert.equal((await db.getSettings()).ferien.length, 1);
  assert.equal((await call(EVA, 'DELETE', `/api/ferien/${res.body.item.id}`)).status, 200);
  assert.equal((await call(EVA, 'DELETE', `/api/ferien/${res.body.item.id}`)).status, 404);
});

// ---------- blocked times ----------

test('blocked times: school holidays, and the week before and after the family holiday', () => {
  const family = [entry('lea', '2026-12-07', '2026-12-11')];
  const b = r.blockedDays({ from: '2026-10-01', to: '2027-09-30', ferien: [HERBST, SOMMER], familyEntries: family });
  assert.equal(b.get('2026-10-27').soft, false);
  assert.match(b.get('2026-10-27').why, /Herbstferien \(Schule\)/);
  assert.equal(b.get('2026-11-30').why, 'Woche vor dem Familienurlaub');
  assert.equal(b.get('2026-12-14').why, 'Woche nach dem Familienurlaub');
  assert.equal(b.has('2026-12-09'), false, 'during the family holiday itself is fine');
  assert.equal(b.has('2026-12-19'), false);
  assert.equal(b.get('2027-08-02').soft, true, 'summer: after talking it through');
});

test('blocked times: warning only for people with Sperrzeiten', async () => {
  const { call } = setup({ ferien: [HERBST, SOMMER], entries: [entry('lea', '2026-12-07', '2026-12-11')] });
  const herbst = { userId: PETRA, kind: 'vacation', start: '2026-10-27', end: '2026-10-30' };
  const res = (await call(EVA, 'POST', '/api/check', herbst)).body.item;
  assert.match(res.warningText, /^4 Tage liegen in einer Sperrzeit: Herbstferien \(Schule\)\. Da ist grundsätzlich kein Urlaub möglich\.$/);
  const after = (await call(EVA, 'POST', '/api/check', { ...herbst, start: '2026-12-14', end: '2026-12-14' })).body.item;
  assert.match(after.warningText, /Woche nach dem Familienurlaub/);
  const summer = (await call(EVA, 'POST', '/api/check', { ...herbst, start: '2027-08-02', end: '2027-08-06' })).body.item;
  assert.match(summer.warningText, /Urlaub nur nach vorheriger Absprache/);
  const karl = (await call(EVA, 'POST', '/api/check', { ...herbst, userId: KARL })).body.item;
  assert.equal(karl.warningText, '');
  // booking still works; approvers see the warning in the inbox
  const booked = await call(EVA, 'POST', '/api/entries', herbst);
  assert.equal(booked.status, 201);
  const inbox = (await call(LEA, 'GET', '/api/requests')).body.item;
  assert.match(inbox.requests[0].warningText, /Sperrzeit/);
});

test('overview month: holidays, blocked days and leave accounts for the planner', async () => {
  const { call } = setup({ ferien: [HERBST] });
  const t = (await call(EVA, 'GET', '/api/team', undefined, { month: '2026-10' })).body.item;
  assert.equal(t.ferien.length, 1);
  assert.ok(t.blocked.some((d) => d.date === '2026-10-27'));
  assert.deepEqual(Object.keys(t.balances).sort(), [KARL, PETRA].sort());
  assert.ok(!t.people.some((p) => p.role === 'office'));
  assert.equal(t.people.find((p) => p.userId === PETRA).sperrzeiten, true);
  const staffView = (await call({ id: 'tom', groups: ['staff'] }, 'GET', '/api/team', undefined, { month: '2026-10' })).body.item;
  assert.deepEqual(staffView.balances, {});
});

// ---------- import ----------

test('import: creates staff without login by name, with start date, rest and blocked times', async () => {
  const { call, db } = setup();
  const body = {
    people: [{ name: 'Nina', create: true, job: 'Nanny', startDate: '2025-11-10', restDays: 25, restAsOf: '2026-10-20' }],
    entries: [{ name: 'Nina', start: '2026-11-23', end: '2026-11-27' }],
  };
  const dry = (await call(EVA, 'POST', '/api/import', body)).body.item;
  assert.deepEqual(dry.problems, []);
  assert.match(dry.people[0], /^Nina \(neu, ohne Zugang\): Eintritt 10\. November 2025, 5 Tage pro Woche, Resturlaub 25 Tage am 20\. Oktober 2026$/);
  assert.equal((await db.listPeople()).length, people.length, 'dry run writes nothing');
  await call(EVA, 'POST', '/api/import', { ...body, dryRun: false });
  const nina = (await db.listPeople()).find((p) => p.name === 'Nina');
  assert.equal(nina.login, false);
  assert.equal(nina.rest.days, 25);
  assert.equal((await db.listUserEntries(nina.userId, '2026-11-01', '2026-11-30')).length, 1);
  const again = (await call(EVA, 'POST', '/api/import', { ...body, dryRun: false })).body.item;
  assert.equal(again.skipped.length, 1);
  assert.equal((await db.listPeople()).length, people.length + 1, 'found by name the second time');
});

// ---------- the children's calendar ----------

// Shaped like a published iCloud calendar: free days, half days and school events mixed.
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iCloud//EN',
  'BEGIN:VEVENT', 'UID:a1', 'DTSTART;VALUE=DATE:20261019', 'DTEND;VALUE=DATE:20261027', 'SUMMARY:Herbstferien / Fall Break (Schule X)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a2', 'DTSTART;TZID=Europe/Vienna:20261002T081500', 'DTEND;TZID=Europe/Vienna:20261002T090000', 'SUMMARY:Coffee Morning', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a3', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20270104', 'SUMMARY:Weihnachtsferien (Kiga Y)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a4', 'DTSTART;TZID=Europe/Vienna:20261106T082000', 'DTEND;TZID=Europe/Vienna:20261106T130000',
  'SUMMARY:Conference afternoon/ NO school for ES Stude', ' nts', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a5', 'DTSTART;VALUE=DATE:20270618', 'DTEND;VALUE=DATE:20270817', 'SUMMARY:Sommerferien / Summer Break (Schule X)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a6', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261031', 'SUMMARY:Halloween', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a7', 'DTSTART;VALUE=DATE:20270528', 'DTEND;VALUE=DATE:20270529', 'SUMMARY:Kiga Y geschlossen', 'STATUS:CANCELLED', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a8', 'DTSTART:20261125T230000Z', 'DTEND:20261127T230000Z', 'SUMMARY:Thanksgiving \\, kein Unterricht', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

test('children\'s calendar: .ics events with folded lines, all-day ends, UTC times', () => {
  const ev = parseIcs(ICS);
  assert.equal(ev.length, 7, 'cancelled event left out');
  assert.deepEqual(ev[0], { uid: 'a1', summary: 'Herbstferien / Fall Break (Schule X)', start: '2026-10-19', end: '2026-10-26' });
  assert.equal(ev.find((e) => e.uid === 'a4').summary, 'Conference afternoon/ NO school for ES Students');
  assert.deepEqual(ev.find((e) => e.uid === 'a8'), { uid: 'a8', summary: 'Thanksgiving , kein Unterricht', start: '2026-11-26', end: '2026-11-28' });
});

test('children\'s calendar: only free days, kindergarten by its word, summer blocked too', () => {
  const days = freeDaysFromIcs(ICS, { free: 'ferien, break, no school, kein unterricht, geschlossen', kindergarten: 'kiga y' });
  assert.deepEqual(days.map((d) => [d.start, d.kind, d.soft]), [
    ['2026-10-19', 'school', false],
    ['2026-11-06', 'school', false],
    ['2026-11-26', 'school', false],
    ['2026-12-24', 'kindergarten', false],
    ['2027-06-18', 'school', false],
  ]);
});

test('children\'s calendar: webcal links become https; only public https links', () => {
  assert.equal(normalizeFeedUrl('webcal://p01-caldav.icloud.com/published/2/abc').value, 'https://p01-caldav.icloud.com/published/2/abc');
  assert.match(normalizeFeedUrl('http://example.at/k.ics').error, /webcal/);
  assert.match(normalizeFeedUrl('https://127.0.0.1/k.ics').error, /öffentlich/);
  assert.equal(normalizeFeedUrl('').value, '');
});

test('children\'s calendar: approvers connect it; days show and block; read again after 3 hours', async () => {
  let reads = 0;
  let now = '2026-10-10T08:00:00Z';
  const db = createMemoryDb({ people, entries: [] });
  const app = createApp({ db, now: () => new Date(now), fetchText: async () => { reads += 1; return ICS; } });
  const call = (user, method, path, body, query = {}) => app.handle({ method, path, body, query, user });
  const body = { url: 'webcal://p01-caldav.icloud.com/published/2/abc', words: { kindergarten: 'kiga y' } };
  assert.equal((await call(EVA, 'PUT', '/api/kinder-kalender', body)).status, 403, 'only approvers set the link');
  const res = (await call(LEA, 'PUT', '/api/kinder-kalender', body)).body.item;
  assert.equal(res.count, 5);
  assert.equal(res.url, 'https://p01-caldav.icloud.com/published/2/abc');
  assert.equal(reads, 1);

  const t = (await call(EVA, 'GET', '/api/team', undefined, { month: '2026-10' })).body.item;
  assert.equal(t.ferien.length, 1);
  assert.ok(t.blocked.some((d) => d.date === '2026-10-20'), 'blocked for people with Sperrzeiten');
  const check = (await call(EVA, 'POST', '/api/check', { userId: PETRA, kind: 'vacation', start: '2026-10-20' })).body.item;
  assert.match(check.warningText, /Herbstferien/);
  assert.equal(reads, 1, 'cached');
  now = '2026-10-10T11:30:00Z';
  await call(EVA, 'GET', '/api/team', undefined, { month: '2026-10' });
  assert.equal(reads, 2, 'read again after 3 hours');
  const sync = (await call(EVA, 'POST', '/api/kinder-kalender/abgleich')).body.item;
  assert.equal(sync.count, 5);
  assert.equal(reads, 3);
  // the calendar's days cannot be edited by hand
  assert.equal((await call(EVA, 'DELETE', `/api/ferien/${t.ferien[0].id}`)).status, 404);
});

test('children\'s calendar: when it cannot be read, the last days stay and the problem shows', async () => {
  let fail = false;
  let now = '2026-10-10T08:00:00Z';
  const db = createMemoryDb({ people, entries: [] });
  const app = createApp({ db, now: () => new Date(now), fetchText: async () => { if (fail) throw new Error('down'); return ICS; } });
  const call = (user, method, path, body, query = {}) => app.handle({ method, path, body, query, user });
  await call(LEA, 'PUT', '/api/kinder-kalender', { url: 'https://cal.example.at/k.ics' });
  fail = true;
  now = '2026-10-11T08:00:00Z';
  const t = (await call(EVA, 'GET', '/api/team', undefined, { month: '2026-10' })).body.item;
  assert.equal(t.ferien.length, 1, 'last days kept');
  const s = (await call(LEA, 'GET', '/api/settings')).body.item.kinderFeed;
  assert.match(s.error, /nicht gelesen/);
  // removing the link removes the days
  await call(LEA, 'PUT', '/api/kinder-kalender', { url: '' });
  assert.equal((await call(EVA, 'GET', '/api/team', undefined, { month: '2026-10' })).body.item.ferien.length, 0);
});
