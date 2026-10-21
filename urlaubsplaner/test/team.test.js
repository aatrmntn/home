// Phase 2: minimum staffing, team view, requests and decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import * as r from '../api/rules.js';
import { createMemoryDb } from '../dev/memory-db.js';

const NOW = new Date('2026-10-14T08:00:00Z');
const FULL = r.FULL_WEEK;
// The household has no minimum by default; these tests switch one on for the staff.
const STAFF = { ...r.DEFAULT_SETTINGS, minimumStaffing: { household: 2 } };
// Same shape as the practice: three in the front office, one part-time in the back office, two owners.
const people = [
  { userId: 'fo1', name: 'Frida', role: 'household', active: true, workPattern: FULL },
  { userId: 'fo2', name: 'Greta', role: 'household', active: true, workPattern: FULL },
  { userId: 'fo3', name: 'Hanna', role: 'household', active: true, workPattern: FULL },
  { userId: 'bo1', name: 'Ida', role: 'office', active: true, workPattern: ['mon', 'tue', 'wed', 'thu'] },
  { userId: 'ow1', name: 'Olga', role: 'family', approver: true, active: true, workPattern: FULL, email: 'olga@example.at' },
  { userId: 'ow2', name: 'Paul', role: 'family', approver: true, active: true, workPattern: FULL, email: 'paul@example.at' },
];
const U = Object.fromEntries(people.map((p) => [p.userId, { id: p.userId, groups: [p.role === 'family' ? 'approver' : 'staff'] }]));

let n = 0;
const entry = (userId, start, end = start, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  userId, kind: 'vacation', reason: '', start, end, half: '', note: 'privat', status: 'approved', rev: 1,
  createdAt: `2026-10-0${(n % 9) + 1}T00:00:00Z`, updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

function setup(entries = []) {
  const db = createMemoryDb({ people, entries, settings: { minimumStaffing: { household: 2 } } });
  const mails = [];
  const app = createApp({ db, now: () => NOW, notify: async (m) => { mails.push(m); }, appUrl: 'https://planer.example/' });
  const call = (user, method, path, body, query = {}) => app.handle({ method, path, body, query, user });
  return { db, call, mails };
}

// ---------- rules ----------

test('staffing: counts present people per role on open days only', () => {
  const dates = ['2026-11-02', '2026-11-06', '2026-11-07', '2026-12-08'];
  const entries = [entry('fo1', '2026-11-02', '2026-11-06')];
  const map = r.staffing({ dates, people, entries, settings: STAFF });
  assert.deepEqual(map.get('2026-11-02'), { open: true, roles: { household: { present: 2, required: 2 } }, below: false });
  assert.equal(map.get('2026-11-07').open, false, 'Saturday');
  assert.equal(map.get('2026-12-08').open, false, 'public holiday');
});

test('staffing: two away is below the minimum; a half day counts for its half', () => {
  const dates = ['2026-11-03'];
  const two = r.staffing({ dates, people, entries: [entry('fo1', '2026-11-03'), entry('fo2', '2026-11-03', '2026-11-03', { half: 'pm' })], settings: STAFF });
  assert.equal(two.get('2026-11-03').roles.household.present, 1);
  assert.equal(two.get('2026-11-03').below, true);
  // one in the morning, one in the afternoon: always two present
  const split = r.staffing({ dates, people, entries: [entry('fo1', '2026-11-03', '2026-11-03', { half: 'am' }), entry('fo2', '2026-11-03', '2026-11-03', { half: 'pm' })], settings: STAFF });
  assert.equal(split.get('2026-11-03').roles.household.present, 2);
});

test('staffing: other absences count as away too; inactive people do not count', () => {
  const dates = ['2026-11-04'];
  const entries = [entry('fo1', '2026-11-04', '2026-11-04', { kind: 'absence', reason: 'training' })];
  const crew = people.map((p) => (p.userId === 'fo3' ? { ...p, active: false } : p));
  assert.equal(r.staffing({ dates, people: crew, entries, settings: STAFF }).get('2026-11-04').roles.household.present, 1);
});

test('staffing warnings: only the requester\'s working days, counting approved entries of others', () => {
  const others = [
    entry('fo2', '2026-11-02', '2026-11-03'), // approved: counts
    entry('fo3', '2026-11-04', '2026-11-04', { status: 'pending' }), // pending: does not count
  ];
  const req = { id: 'x', kind: 'vacation', start: '2026-11-02', end: '2026-11-08', half: '' };
  const w = r.staffingWarnings({ entry: req, owner: people[0], people, entries: others, settings: STAFF });
  assert.deepEqual(w.map((x) => x.date), ['2026-11-02', '2026-11-03']);
  assert.match(r.describeWarnings(w), /^An 2 Tagen \(2\. November bis 3\. November 2026\) wäre im Personal nur 1 Person da\. Gebraucht werden 2\.$/);
  // back office and owners have no minimum
  assert.deepEqual(r.staffingWarnings({ entry: req, owner: people[3], people, entries: others, settings: STAFF }), []);
});

// ---------- API ----------

test('team view: everyone sees names, dates and status, but never notes', async () => {
  const { call } = setup([entry('fo2', '2026-11-02', '2026-11-03'), entry('fo3', '2026-11-03', '2026-11-03', { status: 'pending' })]);
  const res = await call(U.fo1, 'GET', '/api/team', undefined, { month: '2026-11' });
  assert.equal(res.status, 200);
  const t = res.body.item;
  assert.equal(t.people.length, 5, 'the assistant (office) is not in the calendar');
  assert.deepEqual(t.people.map((p) => p.role), ['household', 'household', 'household', 'family', 'family']);
  assert.equal(t.entries.length, 2);
  assert.ok(!JSON.stringify(t).includes('privat'), 'no notes in the team view');
  assert.equal(t.days.length, 30);
  const nov3 = t.days.find((d) => d.date === '2026-11-03');
  assert.equal(nov3.roles.household.present, 2);
  assert.equal(nov3.below, false);
  assert.equal(nov3.belowIfApproved, true);
  assert.equal(t.holidays[0].name, 'Allerheiligen');
  assert.equal((await call(U.fo1, 'GET', '/api/team', undefined, { month: '2026-13' })).status, 400);
});

test('requests inbox and decisions are for approvers only (403)', async () => {
  const pending = entry('fo1', '2026-11-02', '2026-11-06', { status: 'pending' });
  const { call } = setup([pending]);
  assert.equal((await call(U.fo2, 'GET', '/api/requests')).status, 403);
  const res = await call(U.fo1, 'POST', `/api/entries/${pending.id}/decision`, { status: 'approved', expectedRev: 1 });
  assert.equal(res.status, 403, 'not even for your own request');
  assert.equal((await call(U.fo2, 'POST', `/api/entries/${pending.id}/decision`, { status: 'approved', expectedRev: 1 })).status, 403);
});

test('requests inbox lists pending entries with notes and staffing warnings', async () => {
  const { call } = setup([
    entry('fo2', '2026-11-02', '2026-11-03'),
    entry('fo1', '2026-11-02', '2026-11-06', { status: 'pending', note: 'Hochzeit' }),
    entry('ow1', '2026-12-21', '2026-12-23', { status: 'pending' }),
  ]);
  const res = await call(U.ow1, 'GET', '/api/requests');
  const [first, own] = res.body.item.requests;
  assert.equal(first.name, 'Frida');
  assert.equal(first.note, 'Hochzeit');
  assert.equal(first.days, 5);
  assert.deepEqual(first.warnings.map((w) => w.date), ['2026-11-02', '2026-11-03']);
  assert.equal(own.isOwn, true);
  assert.deepEqual(own.warnings, []);
  const overview = (await call(U.ow1, 'GET', '/api/overview')).body.item;
  assert.equal(overview.openRequests, 1, 'own request does not count as open for yourself');
});

test('approve: status, decider and comment saved; stale rev 409; second decision 409', async () => {
  const pending = entry('fo1', '2026-11-02', '2026-11-06', { status: 'pending' });
  const { call, db } = setup([pending]);
  const path = `/api/entries/${pending.id}/decision`;
  assert.equal((await call(U.ow1, 'POST', path, { status: 'maybe', expectedRev: 1 })).status, 400);
  assert.equal((await call(U.ow1, 'POST', path, { status: 'approved', expectedRev: 5 })).status, 409);
  const ok = await call(U.ow1, 'POST', path, { status: 'approved', comment: ' Schönen Urlaub ', expectedRev: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.status, 'approved');
  assert.equal(ok.body.item.rev, 2);
  const saved = await db.getEntry(pending.id);
  assert.equal(saved.decidedBy, 'ow1');
  assert.equal(saved.decisionComment, 'Schönen Urlaub');
  assert.equal(db.audit.at(-1).action, 'approve');
  const again = await call(U.ow2, 'POST', path, { status: 'declined', expectedRev: 2 });
  assert.equal(again.status, 409);
  // the requester now sees the decision comment on the entry
  assert.equal((await call(U.fo1, 'GET', `/api/entries/${pending.id}`)).body.item.decisionComment, 'Schönen Urlaub');
});

test('decline frees the days: no overlap any more, nothing counted', async () => {
  const pending = entry('fo1', '2026-11-02', '2026-11-06', { status: 'pending' });
  const { call } = setup([pending]);
  await call(U.ow2, 'POST', `/api/entries/${pending.id}/decision`, { status: 'declined', expectedRev: 1 });
  const o = (await call(U.fo1, 'GET', '/api/overview')).body.item;
  assert.equal(o.balance.pending, 0);
  assert.equal(o.entries[0].status, 'declined');
  assert.equal((await call(U.fo1, 'POST', '/api/entries', { kind: 'vacation', start: '2026-11-04' })).status, 201);
});

test('emails: new request goes to the other owner(s), decision to the requester; never the note', async () => {
  const { call, mails } = setup([entry('fo2', '2026-11-02', '2026-11-03')]);
  const res = await call(U.fo1, 'POST', '/api/entries', { kind: 'vacation', start: '2026-11-02', end: '2026-11-04', note: 'geheim' });
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['olga@example.at', 'paul@example.at']);
  assert.match(mails[0].subject, /Neuer Antrag von Frida/);
  assert.match(mails[0].text, /Urlaub: 2\. November bis 4\. November 2026 \(3 Tage\)/);
  assert.match(mails[0].text, /Achtung: An 2 Tagen/);
  assert.match(mails[0].text, /https:\/\/planer\.example\//);

  // the family's own holiday needs no approval: approved at once, no mail
  const own = await call(U.ow1, 'POST', '/api/entries', { kind: 'vacation', start: '2026-12-21', note: 'geheim' });
  assert.equal(own.body.item.status, 'approved');
  assert.equal(mails.length, 1);
  // staff without email get no decision mail, and nothing fails
  await call(U.ow1, 'POST', `/api/entries/${res.body.item.id}/decision`, { status: 'approved', expectedRev: 1 });
  assert.equal(mails.length, 1);
  assert.ok(!JSON.stringify(mails).includes('geheim'));
});

test('a failing email never fails the request', async () => {
  const db = createMemoryDb({ people });
  const app = createApp({ db, now: () => NOW, notify: async () => { throw new Error('SES down'); } });
  const res = await app.handle({ method: 'POST', path: '/api/entries', body: { kind: 'vacation', start: '2026-11-02' }, query: {}, user: U.fo1 });
  assert.equal(res.status, 201);
});
