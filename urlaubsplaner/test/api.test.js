import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { parseGroups, userFromClaims } from '../api/claims.js';
import { createMemoryDb } from '../dev/memory-db.js';

const NOW = new Date('2026-10-14T08:00:00Z');
const anna = { userId: 'u-anna', username: 'anna', name: 'Anna', role: 'household', active: true, workPattern: ['mon', 'tue', 'wed', 'thu', 'fri'] };
const berta = { userId: 'u-berta', username: 'berta', name: 'Berta', role: 'household', active: true, workPattern: ['mon', 'tue', 'thu'] };
const chefin = { userId: 'u-chefin', username: 'chefin', name: 'Chefin', role: 'family', active: true, workPattern: ['mon', 'tue', 'wed', 'thu', 'fri'] };
const gone = { userId: 'u-gone', username: 'gone', name: 'Weg', role: 'office', active: false };

const ANNA = { id: 'u-anna', groups: ['staff'] };
const BERTA = { id: 'u-berta', groups: ['staff'] };
const CHEFIN = { id: 'u-chefin', groups: ['approver'] };

function setup(entries = []) {
  const db = createMemoryDb({ people: [anna, berta, chefin, gone], entries, settings: { minimumStaffing: { household: 2 } } });
  const app = createApp({ db, now: () => NOW });
  const call = (user, method, path, body, query = {}) => app.handle({ method, path, body, query, user });
  return { db, call };
}

const approvedPast = {
  id: '11111111-1111-4111-8111-111111111111', userId: 'u-anna', kind: 'vacation', reason: '',
  start: '2026-08-03', end: '2026-08-07', half: '', note: 'Kreta', status: 'approved', rev: 3,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z',
};
const approvedFuture = {
  ...approvedPast, id: '22222222-2222-4222-8222-222222222222', start: '2026-12-21', end: '2026-12-23', note: 'Familie', rev: 1,
};

test('without a login: 401; without a profile or inactive: 403', async () => {
  const { call } = setup();
  assert.equal((await call(null, 'GET', '/api/overview')).status, 401);
  assert.equal((await call({ id: 'u-nobody', groups: [] }, 'GET', '/api/overview')).status, 403);
  const res = await call({ id: 'u-gone', groups: ['staff'] }, 'GET', '/api/overview');
  assert.equal(res.status, 403);
  assert.match(res.body.error, /eingeladen/);
});

test('book a week and a half day; balance shows them as pending', async () => {
  const { call } = setup();
  const week = await call(ANNA, 'POST', '/api/entries', { kind: 'vacation', start: '2026-11-02', end: '2026-11-06', note: 'Wien' });
  assert.equal(week.status, 201);
  assert.equal(week.body.item.status, 'pending');
  assert.equal(week.body.item.days, 5);
  assert.equal(week.body.item.rev, 1);
  const half = await call(ANNA, 'POST', '/api/entries', { kind: 'vacation', start: '2026-11-10', half: 'pm' });
  assert.equal(half.body.item.days, 0.5);

  const o = (await call(ANNA, 'GET', '/api/overview', undefined, { year: '2026' })).body.item;
  assert.equal(o.today, '2026-10-14');
  assert.equal(o.entries.length, 2);
  assert.equal(o.entries[0].note, 'Wien');
  assert.equal(o.holidays.length, 13);
  assert.deepEqual(o.balance, {
    startDate: '2026-01-01', yearStart: '2026-01-01', yearEnd: '2026-12-31',
    allowance: 25, carryOver: 0, total: 25, taken: 0, planned: 0, pending: 5.5, remaining: 25, expired: 0, expiring: null,
  });
  assert.equal(o.me.canApprove, false);
});

test('part-time allowance is scaled', async () => {
  const { call } = setup();
  const o = (await call(BERTA, 'GET', '/api/overview')).body.item;
  assert.equal(o.balance.allowance, 15);
  assert.deepEqual(o.subject.workPattern, ['mon', 'tue', 'thu']);
});

test('the user id comes from the token: staff cannot book for others or approve themselves', async () => {
  const { call, db } = setup();
  const other = await call(ANNA, 'POST', '/api/entries', { kind: 'vacation', start: '2026-11-02', userId: 'u-berta' });
  assert.equal(other.status, 403);
  assert.equal((await db.listUserEntries('u-berta', '2026-01-01', '2026-12-31')).length, 0);
  const res = await call(ANNA, 'POST', '/api/entries', { kind: 'vacation', start: '2026-11-02', status: 'approved', approved: true });
  assert.equal(res.body.item.userId, 'u-anna');
  assert.equal(res.body.item.status, 'pending');
});

test('approvers can enter already agreed leave for someone else', async () => {
  const { call, db } = setup();
  const res = await call(CHEFIN, 'POST', '/api/entries', { kind: 'vacation', start: '2026-12-21', end: '2026-12-23', userId: 'u-berta', approved: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.item.userId, 'u-berta');
  assert.equal(res.body.item.status, 'approved');
  assert.equal(res.body.item.days, 2, "Berta's pattern Mon, Tue, Thu: 21 and 22 Dec, 23 is a Wednesday");
  assert.equal(db.audit.at(-1).action, 'create-approved');
  assert.equal(db.audit.at(-1).actorId, 'u-chefin');
  // checked against Berta's own entries
  const clash = await call(CHEFIN, 'POST', '/api/entries', { kind: 'vacation', start: '2026-12-22', userId: 'u-berta' });
  assert.equal(clash.status, 400);
  const check = await call(CHEFIN, 'POST', '/api/check', { kind: 'vacation', start: '2026-12-28', end: '2026-12-31', userId: 'u-berta' });
  assert.equal(check.body.item.days, 3);
  assert.equal((await call(CHEFIN, 'POST', '/api/entries', { kind: 'vacation', start: '2026-12-28', userId: 'u-gone' })).status, 404);
  const o = (await call(CHEFIN, 'GET', '/api/overview')).body.item;
  assert.deepEqual(o.people.map((p) => p.name), ['Anna', 'Berta', 'Chefin']);
  assert.deepEqual((await call(ANNA, 'GET', '/api/overview')).body.item.people, []);
});

test("someone else's entry is a 404 for staff, visible with note for approvers", async () => {
  const { call } = setup([approvedFuture]);
  const path = `/api/entries/${approvedFuture.id}`;
  for (const [method, body, query] of [['GET'], ['PUT', { kind: 'vacation', start: '2026-12-21', expectedRev: 1 }], ['DELETE', undefined, { rev: '1' }]]) {
    const res = await call(BERTA, method, path, body, query);
    assert.equal(res.status, 404, method);
    assert.equal(res.body.error, 'Diesen Eintrag gibt es nicht (mehr).');
  }
  const missing = await call(BERTA, 'GET', '/api/entries/33333333-3333-4333-8333-333333333333');
  assert.deepEqual(missing.body, { error: 'Diesen Eintrag gibt es nicht (mehr).' });

  const boss = await call(CHEFIN, 'GET', path);
  assert.equal(boss.status, 200);
  assert.equal(boss.body.item.note, 'Familie');
});

test('overlap and validation errors are 400 with a clear message', async () => {
  const { call } = setup([approvedFuture]);
  const res = await call(ANNA, 'POST', '/api/entries', { kind: 'vacation', start: '2026-12-23', end: '2026-12-30' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /überschneidet sich mit deinem Eintrag vom 21\. Dezember bis 23\. Dezember 2026/);
  const sat = await call(ANNA, 'POST', '/api/entries', { kind: 'vacation', start: '2026-10-17', end: '2026-10-18' });
  assert.match(sat.body.error, /nichts zu buchen/);
  const closure = await call(CHEFIN, 'POST', '/api/entries', { kind: 'closure', start: '2026-12-28' });
  assert.equal(closure.status, 400);
  const bad = await call(ANNA, 'POST', '/api/entries', 'kaputt');
  assert.equal(bad.status, 400);
});

test("another person's entries do not cause overlaps", async () => {
  const { call } = setup([approvedFuture]);
  const res = await call(BERTA, 'POST', '/api/entries', { kind: 'vacation', start: '2026-12-21' });
  assert.equal(res.status, 201);
});

test('update: stale rev gives 409; changing dates of an approved entry sets it back to pending', async () => {
  const { call } = setup([approvedFuture]);
  const path = `/api/entries/${approvedFuture.id}`;
  const stale = await call(ANNA, 'PUT', path, { kind: 'vacation', start: '2026-12-21', end: '2026-12-22', expectedRev: 0 });
  assert.equal(stale.status, 400);
  const old = await call(ANNA, 'PUT', path, { kind: 'vacation', start: '2026-12-21', end: '2026-12-22', expectedRev: 7 });
  assert.equal(old.status, 409);
  assert.match(old.body.error, /inzwischen geändert/);

  const noteOnly = await call(ANNA, 'PUT', path, { kind: 'vacation', start: '2026-12-21', end: '2026-12-23', note: 'Oma', expectedRev: 1 });
  assert.equal(noteOnly.body.item.status, 'approved');
  assert.equal(noteOnly.body.item.rev, 2);

  const moved = await call(ANNA, 'PUT', path, { kind: 'vacation', start: '2026-12-21', end: '2026-12-22', note: 'Oma', expectedRev: 2 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.status, 'pending');
  assert.equal(moved.body.item.days, 2);
  assert.equal(moved.body.item.rev, 3);
});

test('delete own entry needs the current rev', async () => {
  const { call } = setup([approvedFuture]);
  const path = `/api/entries/${approvedFuture.id}`;
  assert.equal((await call(ANNA, 'DELETE', path, undefined, {})).status, 400);
  assert.equal((await call(ANNA, 'DELETE', path, undefined, { rev: '2' })).status, 409);
  assert.equal((await call(ANNA, 'DELETE', path, undefined, { rev: '1' })).status, 200);
  assert.equal((await call(ANNA, 'GET', path)).status, 404);
});

test('staff cannot change or delete approved entries that already started; approvers can', async () => {
  const { call } = setup([approvedPast]);
  const path = `/api/entries/${approvedPast.id}`;
  const del = await call(ANNA, 'DELETE', path, undefined, { rev: '3' });
  assert.equal(del.status, 403);
  const put = await call(ANNA, 'PUT', path, { kind: 'vacation', start: '2026-08-03', end: '2026-08-04', expectedRev: 3 });
  assert.equal(put.status, 403);
  const boss = await call(CHEFIN, 'DELETE', path, undefined, { rev: '3' });
  assert.equal(boss.status, 200);
});

test('check: days and what is left, without writing', async () => {
  const { call, db } = setup([approvedFuture]);
  const res = await call(ANNA, 'POST', '/api/check', { kind: 'vacation', start: '2026-12-28', end: '2027-01-08' });
  const { warnings, warningText, ...rest } = res.body.item;
  // 25 days, 3 already planned in December, 8 more now
  assert.deepEqual(rest, { ok: true, days: 8, remainingAfter: 14 });
  assert.equal(warnings.length, 8, 'with only two people in the front office, every day of Anna\'s is short');
  const err = await call(ANNA, 'POST', '/api/check', { kind: 'vacation', start: '2026-12-22' });
  assert.equal(err.body.item.ok, false);
  assert.match(err.body.item.error, /überschneidet/);
  // editing the entry itself does not clash with itself, and its own days are not counted twice
  const edit = await call(ANNA, 'POST', '/api/check', { id: approvedFuture.id, kind: 'vacation', start: '2026-12-21', end: '2026-12-22' });
  assert.equal(edit.body.item.remainingAfter, 23);
  assert.equal(db.audit.length, 0);
});

test('every write leaves an audit record without the note', async () => {
  const { call, db } = setup();
  const res = await call(ANNA, 'POST', '/api/entries', { kind: 'absence', reason: 'training', start: '2026-11-12', note: 'geheim' });
  const id = res.body.item.id;
  await call(ANNA, 'PUT', `/api/entries/${id}`, { kind: 'absence', reason: 'training', start: '2026-11-13', note: 'geheim', expectedRev: 1 });
  await call(ANNA, 'DELETE', `/api/entries/${id}`, undefined, { rev: '2' });
  assert.deepEqual(db.audit.map((a) => a.action), ['create', 'update', 'delete']);
  assert.ok(db.audit.every((a) => a.actorId === 'u-anna' && a.entryId === id));
  assert.ok(!JSON.stringify(db.audit).includes('geheim'));
});

test('own display name', async () => {
  const { call, db } = setup();
  assert.equal((await call(ANNA, 'PUT', '/api/me', { name: '  Anna M. ' })).body.item.name, 'Anna M.');
  assert.equal((await db.getPerson('u-anna')).name, 'Anna M.');
  assert.equal((await call(ANNA, 'PUT', '/api/me', { name: '' })).status, 400);
});

test('unknown routes are 404', async () => {
  const { call } = setup();
  assert.equal((await call(ANNA, 'GET', '/api/nope')).status, 404);
  assert.equal((await call(ANNA, 'GET', '/api/entries/../people')).status, 404);
});

test('token claims: only access tokens, groups in either format', () => {
  assert.deepEqual(parseGroups('[approver staff]'), ['approver', 'staff']);
  assert.deepEqual(parseGroups(['staff']), ['staff']);
  assert.deepEqual(parseGroups(undefined), []);
  assert.equal(userFromClaims({ sub: 'x', token_use: 'id' }), null);
  assert.deepEqual(userFromClaims({ sub: 'x', token_use: 'access', 'cognito:groups': '[staff]' }), { id: 'x', groups: ['staff'] });
});
