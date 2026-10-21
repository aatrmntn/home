// Phase 3: closures, settings, people management, export, calendar feed, retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { toCsv } from '../api/csv.js';
import { calendar, fold } from '../api/ical.js';
import * as r from '../api/rules.js';
import { createMemoryDb } from '../dev/memory-db.js';

const FULL = r.FULL_WEEK;
const people = [
  { userId: 'fo1', username: 'frida', name: 'Frida', role: 'household', active: true, workPattern: FULL },
  { userId: 'bo1', username: 'ida', name: 'Ida', role: 'office', active: true, workPattern: ['mon', 'tue', 'wed', 'thu'], startDate: '2026-03-09' },
  { userId: 'ow1', username: 'olga', name: 'Olga', role: 'family', active: true, approver: true, workPattern: FULL },
  { userId: 'ow2', username: 'paul', name: 'Paul', role: 'family', active: true, approver: true, workPattern: FULL },
];
const FO = { id: 'fo1', groups: ['staff'] };
const BO = { id: 'bo1', groups: ['staff'] };
const OW = { id: 'ow1', groups: ['approver'] };

let n = 0;
const entry = (userId, start, end = start, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  userId, kind: 'vacation', reason: '', start, end, half: '', note: 'privat', status: 'approved', rev: 1,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

function setup({ entries = [], now = '2026-10-14T08:00:00Z' } = {}) {
  const db = createMemoryDb({ people, entries });
  const calls = [];
  const directory = {
    async createUser(args) { calls.push(['create', args]); return { userId: 'new-1', startPassword: 'Start-Passwort-1' }; },
    async setEnabled(...args) { calls.push(['enabled', ...args]); },
    async setGroup(...args) { calls.push(['group', ...args]); },
  };
  const app = createApp({ db, now: () => new Date(now), directory, appUrl: 'https://planer.example/' });
  const call = (user, method, path, body, query = {}) => app.handle({ method, path, body, query, user });
  return { db, call, calls, app };
}

// ---------- closures ----------

test('closures: only approvers create them; they count as vacation when set so', async () => {
  const { call } = setup();
  const body = { start: '2026-12-24', end: '2027-01-06', label: 'Weihnachten', countsAsVacation: true, substitute: 'Dr. Muster' };
  assert.equal((await call(FO, 'POST', '/api/closures', body)).status, 403);
  const res = await call(OW, 'POST', '/api/closures', body);
  assert.equal(res.status, 201);
  assert.equal(res.body.item.reopens, '2027-01-07');
  assert.equal(res.body.item.substitute, 'Dr. Muster');

  const o = (await call(FO, 'GET', '/api/overview')).body.item;
  assert.equal(o.closures.length, 1);
  // 24, 28, 29, 30, 31 Dec and 4, 5 Jan are working days for a full week (25, 26 Dec, 1, 6 Jan holidays)
  assert.equal(o.balance.planned, 7);
  const ida = (await call(BO, 'GET', '/api/overview')).body.item;
  assert.equal(ida.balance.planned, 7, 'Ida works Mon–Thu: the same seven days are all hers');
  // nobody can book vacation on closure days alone
  const book = await call(FO, 'POST', '/api/entries', { kind: 'vacation', start: '2026-12-28', end: '2026-12-31' });
  assert.match(book.body.error, /nichts zu buchen/);
});

test('closures: change with rev, delete, and the team view shows them as closed', async () => {
  const { call } = setup();
  const made = (await call(OW, 'POST', '/api/closures', { start: '2026-11-02', end: '2026-11-03', label: 'Umbau' })).body.item;
  const t = (await call(FO, 'GET', '/api/team', undefined, { month: '2026-11' })).body.item;
  assert.equal(t.days.find((d) => d.date === '2026-11-02').open, false);
  const path = `/api/closures/${made.id}`;
  assert.equal((await call(OW, 'PUT', path, { start: '2026-11-02', end: '2026-11-04', expectedRev: 9 })).status, 409);
  const changed = await call(OW, 'PUT', path, { start: '2026-11-02', end: '2026-11-04', label: 'Umbau', expectedRev: 1 });
  assert.equal(changed.body.item.end, '2026-11-04');
  assert.equal((await call(FO, 'DELETE', path, undefined, { rev: '2' })).status, 403);
  assert.equal((await call(OW, 'DELETE', path, undefined, { rev: '2' })).status, 200);
  assert.equal((await call(OW, 'DELETE', path, undefined, { rev: '2' })).status, 404);
});

test('substitute: household staff can have a stand-in, the family cannot', async () => {
  const { call } = setup();
  const staff = await call(FO, 'POST', '/api/entries', { kind: 'vacation', start: '2026-11-12', substitute: 'Vera' });
  assert.equal(staff.body.item.substitute, 'Vera');
  const own = await call(OW, 'POST', '/api/entries', { kind: 'absence', reason: 'training', start: '2026-11-12', substitute: 'Jemand' });
  assert.equal(own.body.item.substitute, '');
});

// ---------- settings ----------

test('settings: approvers only; validated; used for staffing', async () => {
  const { call } = setup();
  assert.equal((await call(FO, 'GET', '/api/settings')).status, 403);
  assert.equal((await call(FO, 'PUT', '/api/settings', { openDays: ['mon'] })).status, 403);
  const cur = (await call(OW, 'GET', '/api/settings')).body.item;
  assert.deepEqual(cur.minimumStaffing, {}, 'no minimum in a household by default');
  assert.equal((await call(OW, 'PUT', '/api/settings', { openDays: [] })).status, 400);
  assert.equal((await call(OW, 'PUT', '/api/settings', { minimumStaffing: { household: 1.5 } })).status, 400);
  const saved = await call(OW, 'PUT', '/api/settings', { minimumStaffing: { household: 1, office: 1 }, absenceNeedsApproval: false });
  assert.deepEqual(saved.body.item.minimumStaffing, { household: 1, office: 1 });
  const absence = await call(FO, 'POST', '/api/entries', { kind: 'absence', reason: 'training', start: '2026-11-12' });
  assert.equal(absence.body.item.status, 'approved', 'no approval needed any more');
});

// ---------- people ----------

test('people: list with leave year and balance, approvers only', async () => {
  const { call } = setup({ entries: [entry('bo1', '2026-10-05', '2026-10-08')] });
  assert.equal((await call(FO, 'GET', '/api/people')).status, 403);
  const list = (await call(OW, 'GET', '/api/people')).body.item.people;
  const ida = list.find((p) => p.userId === 'bo1');
  assert.equal(ida.startDate, '2026-03-09');
  assert.equal(ida.defaultAllowance, 20);
  assert.equal(ida.balance.yearStart, '2026-03-09');
  assert.equal(ida.balance.yearEnd, '2027-03-08');
  assert.equal(ida.balance.remaining, 16);
  const frida = list.find((p) => p.userId === 'fo1');
  assert.equal(frida.startDate, '', 'no start date: leave year = calendar year from the planner start');
  assert.equal(frida.balance.yearStart, '2026-01-01');
});

test('people: change start date, pattern, allowance and correction; validation', async () => {
  const { call, db } = setup();
  const path = '/api/people/fo1';
  assert.equal((await call(FO, 'PUT', path, { name: 'X' })).status, 403);
  assert.equal((await call(OW, 'PUT', '/api/people/nobody', { name: 'X' })).status, 404);
  assert.equal((await call(OW, 'PUT', path, { workPattern: [] })).status, 400);
  assert.equal((await call(OW, 'PUT', path, { startDate: '2026-02-30' })).status, 400);
  assert.equal((await call(OW, 'PUT', path, { yearStart: '2026-06-01', allowance: 25.3 })).status, 400);
  assert.equal((await call(OW, 'PUT', path, { extraDays: 0.3 })).status, 400);
  const res = await call(OW, 'PUT', path, { startDate: '2026-06-01', extraDays: 1, extraNote: 'Mai 2026 (20 Std.)' });
  assert.equal(res.status, 200);
  assert.equal(res.body.item.balance.yearStart, '2026-06-01');
  assert.equal(res.body.item.balance.total, 26);
  const changed = await call(OW, 'PUT', path, { workPattern: ['mon', 'tue', 'wed', 'thu'], yearStart: '2026-06-01', allowance: 22 });
  assert.equal(changed.body.item.allowanceOverride, 22);
  assert.equal(changed.body.item.balance.total, 23, '22 plus the correction of 1');
  const saved = await db.getPerson('fo1');
  assert.deepEqual(saved.workPattern, ['mon', 'tue', 'wed', 'thu']);
  assert.equal(saved.extraNote, 'Mai 2026 (20 Std.)');
  // back to automatic
  const auto = await call(OW, 'PUT', path, { yearStart: '2026-06-01', allowance: null, extraDays: 0 });
  assert.equal(auto.body.item.allowanceOverride, null);
  assert.equal(auto.body.item.balance.total, 20);
  assert.equal(db.audit.filter((a) => a.action === 'person-update').length, 3);
});

test('people: deactivate and approver rights go through the login system; not for yourself', async () => {
  const { call, calls, db } = setup();
  assert.equal((await call(OW, 'PUT', '/api/people/ow1', { active: false })).status, 400);
  assert.equal((await call(OW, 'PUT', '/api/people/ow1', { approver: false })).status, 400);
  await call(OW, 'PUT', '/api/people/fo1', { active: false });
  await call(OW, 'PUT', '/api/people/bo1', { approver: true });
  assert.deepEqual(calls, [['enabled', 'frida', false], ['group', 'ida', 'approver', 'staff']]);
  assert.equal((await db.getPerson('fo1')).active, false);
  // a deactivated person cannot use the planner and leaves the team view
  assert.equal((await call(FO, 'GET', '/api/overview')).status, 403);
  const t = (await call(OW, 'GET', '/api/team', undefined, { month: '2026-11' })).body.item;
  assert.ok(!t.people.some((p) => p.userId === 'fo1'));
});

test('people: add a person, start password shown once, username must be new', async () => {
  const { call, calls, db } = setup();
  const body = { username: 'Vera', name: 'Vera', role: 'household', workPattern: FULL };
  assert.equal((await call(FO, 'POST', '/api/people', body)).status, 403);
  assert.equal((await call(OW, 'POST', '/api/people', { ...body, username: 'v' })).status, 400);
  assert.equal((await call(OW, 'POST', '/api/people', { ...body, username: 'frida' })).status, 409);
  const res = await call(OW, 'POST', '/api/people', { ...body, email: 'vera@example.at' });
  assert.equal(res.status, 201);
  assert.equal(res.body.item.startPassword, 'Start-Passwort-1');
  assert.equal(res.body.item.person.username, 'vera');
  assert.deepEqual(calls[0], ['create', { username: 'vera', email: 'vera@example.at', group: 'staff' }]);
  assert.equal((await db.getPerson('new-1')).role, 'household');
  assert.ok(!JSON.stringify(db.audit).includes('Start-Passwort'), 'passwords never in the audit log');
});

// ---------- export and feed ----------

test('ical: CRLF, folding at 75 octets without breaking characters, escaping', () => {
  const long = `SUMMARY:${'Ä'.repeat(60)}`;
  const folded = fold(long).split('\r\n');
  assert.ok(folded.every((l) => Buffer.byteLength(l) <= 75));
  assert.ok(folded.slice(1).every((l) => l.startsWith(' ')));
  assert.equal(folded.map((l, i) => (i ? l.slice(1) : l)).join(''), long);

  const ics = calendar({
    name: 'Test',
    events: [
      { uid: 'a@x', start: '2026-11-02', end: '2026-11-04', summary: 'Anna: Urlaub', updatedAt: '2026-10-01T10:00:00.000Z' },
      { uid: 'b@x', start: '2026-11-05', end: '2026-11-05', half: 'pm', summary: 'Kurs; Teil 1, neu', updatedAt: '2026-10-01T10:00:00Z' },
    ],
  });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'only CRLF line endings');
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Vienna/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261105/);
  assert.match(ics, /DTSTART;TZID=Europe\/Vienna:20261105T130000\r\nDTEND;TZID=Europe\/Vienna:20261105T170000/);
  assert.match(ics, /SUMMARY:Kurs\\; Teil 1\\, neu/);
  assert.match(ics, /DTSTAMP:20261001T100000Z/);
  assert.equal((ics.match(/TRANSP:TRANSPARENT/g) || []).length, 2);
});

test('csv: semicolons, BOM, quotes, and formulas are made harmless', () => {
  const csv = toCsv([['a', 'b;c', 'say "hi"', '=HYPERLINK("x")', '-5']]);
  assert.equal(csv, '﻿a;"b;c";"say ""hi""";"\'=HYPERLINK(""x"")";\'-5\r\n');
});

test('export: own entries as .ics and .csv, with notes (they are your own)', async () => {
  const { call } = setup({ entries: [entry('fo1', '2026-08-03', '2026-08-07', { note: '=Kreta' }), entry('bo1', '2026-08-03')] });
  const ics = await call(FO, 'GET', '/api/export.ics', undefined, { year: '2026' });
  assert.equal(ics.status, 200);
  assert.equal(ics.contentType, 'text/calendar; charset=utf-8');
  assert.equal(ics.filename, 'abwesenheiten-2026.ics');
  assert.equal((ics.raw.match(/BEGIN:VEVENT/g) || []).length, 1, 'only own entries');
  const csv = await call(FO, 'GET', '/api/export.csv', undefined, { year: '2026' });
  assert.match(csv.raw, /03\.08\.2026;07\.08\.2026;Urlaub;;5;bestätigt;'=Kreta;/);
});

test('feed: token link shows the team without notes; replace kills the old link; inactive owner 404', async () => {
  const { call, db } = setup({
    entries: [
      entry('fo1', '2026-11-02', '2026-11-03', { note: 'geheim' }),
      entry('bo1', '2026-11-05', '2026-11-05', { status: 'pending' }),
      entry('ow1', '2026-12-01', '2026-12-01', { kind: 'closure', reason: 'Fortbildung Team', substitute: 'Dr. Muster' }),
      entry('fo1', '2025-01-02'), // too old
    ],
  });
  const first = (await call(FO, 'PUT', '/api/me/feed')).body.item.url;
  const token = first.match(/feed\/([A-Za-z0-9_-]{32})\.ics$/)[1];
  assert.equal((await call(FO, 'GET', '/api/overview')).body.item.me.feedUrl, first);

  const res = await call(null, 'GET', `/feed/${token}.ics`);
  assert.equal(res.status, 200);
  assert.match(res.raw, /SUMMARY:Frida: Urlaub/);
  assert.match(res.raw, /SUMMARY:NW7: alle frei \(Fortbildung Team\)/);
  assert.match(res.raw, /DESCRIPTION:Vertretung: Dr. Muster/);
  assert.ok(!res.raw.includes('geheim'), 'never notes');
  assert.ok(!res.raw.includes('Ida'), 'only approved entries');
  assert.ok(!res.raw.includes('20250102'), 'only from last month on');

  const second = (await call(FO, 'PUT', '/api/me/feed')).body.item.url;
  assert.notEqual(second, first);
  assert.equal((await call(null, 'GET', `/feed/${token}.ics`)).status, 404, 'old link is dead at once');
  const token2 = second.match(/feed\/(.+)\.ics$/)[1];
  assert.equal((await call(null, 'GET', `/feed/${token2}.ics`)).status, 200);

  await db.putPerson({ ...(await db.getPerson('fo1')), active: false });
  assert.equal((await call(null, 'GET', `/feed/${token2}.ics`)).status, 404);
  assert.equal((await call(null, 'GET', '/feed/short.ics')).status, 404);
  assert.equal((await call(null, 'GET', '/feed/../api/overview')).status, 404);
  assert.ok(!JSON.stringify(db.audit).includes(token2), 'tokens never in the audit log');
});

test('feed: delete the link', async () => {
  const { call } = setup();
  const url = (await call(FO, 'PUT', '/api/me/feed')).body.item.url;
  await call(FO, 'DELETE', '/api/me/feed');
  const token = url.match(/feed\/(.+)\.ics$/)[1];
  assert.equal((await call(null, 'GET', `/feed/${token}.ics`)).status, 404);
  assert.equal((await call(FO, 'GET', '/api/overview')).body.item.me.feedUrl, '');
});

// ---------- retention ----------

test('retention: keeps this year and the two before, deletes older entries and audit', async () => {
  const old = entry('fo1', '2023-12-27', '2024-01-05'); // ends in 2024: keep
  const older = entry('fo1', '2023-08-01', '2023-08-05'); // delete
  const { app, db } = setup({ entries: [old, older, entry('fo1', '2026-08-03')], now: '2026-01-02T02:00:00Z' });
  db.audit.push({ id: 'a1', at: '2023-05-01T00:00:00.000Z', action: 'create' }, { id: 'a2', at: '2024-02-01T00:00:00.000Z', action: 'create' });
  const res = await app.runRetention();
  assert.deepEqual(res, { cutoff: '2024-01-01', deletedEntries: 1, deletedAudit: 1 });
  assert.equal(await db.getEntry(older.id), null);
  assert.ok(await db.getEntry(old.id));
  assert.ok(db.audit.some((a) => a.id === 'a2'));
  assert.ok(db.audit.some((a) => a.action === 'retention' && a.actorId === 'system'));
});

test('retention: balances stay the same after old entries are deleted', async () => {
  const entries = [
    entry('fo1', '2024-08-05'), entry('fo1', '2024-12-27', '2025-01-09'), entry('fo1', '2025-09-15', '2025-09-26'),
    entry('fo1', '2026-04-22', '2026-04-30'), entry('fo1', '2027-01-19', '2027-02-11'),
    entry('ow1', '2024-12-31', '2024-12-31', { kind: 'closure', reason: 'Silvester' }),
  ];
  const { app, db } = setup({ entries, now: '2027-01-02T02:00:00Z' });
  await db.putPerson({ ...(await db.getPerson('fo1')), startDate: '2024-05-02' });
  const before = (await app.handle({ method: 'GET', path: '/api/overview', query: {}, user: FO })).body.item.balance;
  const res = await app.runRetention();
  assert.equal(res.cutoff, '2025-01-01');
  assert.equal(res.deletedEntries, 2, 'the August 2024 entry and the 2024 closure');
  assert.ok((await db.getPerson('fo1')).snapshot);
  const after = (await app.handle({ method: 'GET', path: '/api/overview', query: {}, user: FO })).body.item.balance;
  assert.deepEqual(after, before);
});

test('import: dry run writes nothing; then people, closures and approved entries; twice is harmless', async () => {
  const { call, db } = setup();
  const body = {
    people: [{ username: 'frida', startDate: '2024-05-02' }, { username: 'nobody', startDate: '2024-01-01' }],
    closures: [{ start: '2024-12-31', label: 'Silvester' }],
    entries: [
      { username: 'frida', start: '2024-12-27', end: '2025-01-09', note: 'alt' },
      { username: 'frida', start: '2026-10-30' },
      { username: 'frida', start: '2026-10-30' },
      { username: 'frida', start: '2026-10-31' },
      { username: 'ida', start: '2026-10-05', end: '2026-10-08' },
    ],
  };
  assert.equal((await call(FO, 'POST', '/api/import', body)).status, 403);
  const dry = (await call(OW, 'POST', '/api/import', body)).body.item;
  assert.equal(dry.dryRun, true);
  assert.equal(dry.entries.length, 3);
  assert.match(dry.entries[0], /Frida, 27\. Dezember 2024 bis 9\. Jänner 2025 \(7 Tage\)/, 'Silvester 2024 is free');
  assert.equal(dry.skipped.length, 1, 'the second 30 October');
  assert.equal(dry.problems.length, 2, 'unknown person and a Saturday');
  assert.equal(db.audit.length, 0);

  const real = (await call(OW, 'POST', '/api/import', { ...body, dryRun: false })).body.item;
  assert.equal(real.entries.length, 3);
  assert.equal((await db.getPerson('fo1')).startDate, '2024-05-02');
  const own = await db.listUserEntries('fo1', '2024-01-01', '2026-12-31');
  assert.ok(own.every((e) => e.status === 'approved'));
  const o = (await call(FO, 'GET', '/api/overview')).body.item;
  assert.equal(o.balance.yearStart, '2026-05-02');
  assert.equal(o.balance.remaining, 75 - 7 - 1);

  const again = (await call(OW, 'POST', '/api/import', { ...body, dryRun: false })).body.item;
  assert.equal(again.entries.length, 0);
  assert.equal(again.closures.length, 0);
});

test('mail test: approvers only, needs email switched on and an address; shows send errors', async () => {
  const sent = [];
  let fail = false;
  const db = createMemoryDb({ people });
  const app = createApp({ db, now: () => new Date('2026-10-14T08:00:00Z'), notify: async (m) => { if (fail) throw new Error('x'); sent.push(m); } });
  const call = (user) => app.handle({ method: 'POST', path: '/api/mail-test', query: {}, user });
  assert.equal((await call(FO)).status, 403);
  assert.match((await call(OW)).body.error, /keine E-Mail-Adresse/);
  await app.handle({ method: 'PUT', path: '/api/people/ow1', body: { email: 'olga@example.at' }, query: {}, user: OW });
  const ok = await call(OW);
  assert.equal(ok.body.item.sentTo, 'olga@example.at');
  assert.equal(sent[0].subject, 'Test vom Urlaubsplaner');
  fail = true;
  assert.equal((await call(OW)).status, 502);
  const off = createApp({ db, now: () => new Date() });
  assert.match((await off.handle({ method: 'POST', path: '/api/mail-test', query: {}, user: OW })).body.error, /noch nicht eingeschaltet/);
  assert.equal((await app.handle({ method: 'PUT', path: '/api/people/ow1', body: { email: 'kaputt' }, query: {}, user: OW })).status, 400);
});
