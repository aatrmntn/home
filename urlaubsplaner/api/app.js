// Routes of the API. Independent of AWS: the Lambda handler and the local dev server both
// pass in a request and a database. Every route checks the caller itself.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { toCsv } from './csv.js';
import { ConflictError, HttpError } from './errors.js';
import { calendar } from './ical.js';
import { DEFAULT_WORDS, freeDaysFromIcs, normalizeFeedUrl } from './kinder-feed.js';
import * as rules from './rules.js';

export { ConflictError, HttpError };

const NOT_FOUND = 'Diesen Eintrag gibt es nicht (mehr).';
const NOT_SET_UP = 'Dein Zugang ist noch nicht eingerichtet. Bitte melde dich bei der Person, die dich eingeladen hat.';

// notify (optional): async ({ to: [emails], subject, text }) => void. Used for request emails.
// directory (optional): the login system (Cognito), so approvers can add and disable people:
//   createUser({ username, email, approver }) => { userId, startPassword }
//   setEnabled(username, enabled), setApprover(username, approver)
// appUrl: the planner's address ending in '/', for email links and the calendar feed.
// fetchText (optional): async (url) => text, to read the children's calendar.
export function createApp({ db, now = () => new Date(), notify = null, directory = null, appUrl = '', fetchText = defaultFetchText }) {
  async function handle(req) {
    try {
      if (req.path.startsWith('/feed/')) {
        const feed = req.method === 'GET' && req.path.match(/^\/feed\/([A-Za-z0-9_-]{32})\.ics$/);
        return await feedResponse(feed ? feed[1] : null);
      }
      const body = await route(req);
      if (body?.raw !== undefined) {
        return { status: 200, raw: body.raw, contentType: body.contentType, filename: body.filename };
      }
      return { status: req.method === 'POST' && body?.created ? 201 : 200, body: strip(body) };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      console.error('Unexpected error', err?.name, err?.message);
      return { status: 500, body: { error: 'Etwas ist schiefgelaufen. Bitte versuche es gleich noch einmal.' } };
    }
  }

  async function route(req) {
    if (!req.user?.id) throw new HttpError(401, 'Bitte melde dich an.');
    const path = req.path.replace(/\/+$/, '');
    const m = path.match(/^\/api\/entries\/([0-9a-f-]{36})$/);
    const decision = path.match(/^\/api\/entries\/([0-9a-f-]{36})\/decision$/);
    const closure = path.match(/^\/api\/closures\/([0-9a-f-]{36})$/);
    const personPath = path.match(/^\/api\/people\/([A-Za-z0-9_.:-]{1,64})$/);

    if (req.method === 'GET' && path === '/api/overview') return overview(req);
    if (req.method === 'POST' && path === '/api/check') return check(req);
    if (req.method === 'POST' && path === '/api/entries') return createEntry(req);
    if (req.method === 'PUT' && path === '/api/me') return updateMe(req);
    if (req.method === 'GET' && path === '/api/team') return team(req);
    if (req.method === 'GET' && path === '/api/requests') return requests(req);
    if (decision && req.method === 'POST') return decide(req, decision[1]);
    const ferienPath = path.match(/^\/api\/ferien\/([0-9a-f-]{36})$/);
    if (req.method === 'POST' && path === '/api/ferien') return createFerien(req);
    if (req.method === 'PUT' && path === '/api/kinder-kalender') return putKinderFeed(req);
    if (req.method === 'POST' && path === '/api/kinder-kalender/abgleich') return syncKinderFeed(req);
    if (ferienPath && req.method === 'PUT') return updateFerien(req, ferienPath[1]);
    if (ferienPath && req.method === 'DELETE') return deleteFerien(req, ferienPath[1]);
    if (req.method === 'POST' && path === '/api/closures') return createClosure(req);
    if (closure && req.method === 'PUT') return updateClosure(req, closure[1]);
    if (closure && req.method === 'DELETE') return deleteClosure(req, closure[1]);
    if (req.method === 'GET' && path === '/api/settings') return getSettings(req);
    if (req.method === 'PUT' && path === '/api/settings') return putSettings(req);
    if (req.method === 'GET' && path === '/api/people') return listPeople(req);
    if (req.method === 'POST' && path === '/api/people') return addPerson(req);
    if (personPath && req.method === 'PUT') return updatePerson(req, personPath[1]);
    if (req.method === 'POST' && path === '/api/import') return importData(req);
    if (req.method === 'POST' && path === '/api/mail-test') return mailTest(req);
    if (req.method === 'GET' && path === '/api/export.ics') return exportIcs(req);
    if (req.method === 'GET' && path === '/api/export.csv') return exportCsv(req);
    if (req.method === 'PUT' && path === '/api/me/feed') return createFeed(req);
    if (req.method === 'DELETE' && path === '/api/me/feed') return deleteFeed(req);
    if (m && req.method === 'GET') return getEntry(req, m[1]);
    if (m && req.method === 'PUT') return updateEntry(req, m[1]);
    if (m && req.method === 'DELETE') return deleteEntry(req, m[1]);
    if (path.startsWith('/api/entries/')) throw new HttpError(404, NOT_FOUND);
    throw new HttpError(404, 'Diese Adresse gibt es nicht.');
  }

  // ----- helpers -----

  async function caller(req) {
    const person = await db.getPerson(req.user.id);
    if (!person || person.active === false) throw new HttpError(403, NOT_SET_UP);
    const groups = req.user.groups || [];
    const isApprover = groups.includes('approver');
    // Planner (the assistant): enters for everyone and keeps the lists, but does not approve.
    const isPlanner = groups.includes('planner');
    return { person, isApprover, isPlanner, canPlan: isApprover || isPlanner };
  }

  async function context() {
    const settings = { ...rules.DEFAULT_SETTINGS, ...(await db.getSettings()) };
    const today = rules.todayIn(settings.timeZone, now());
    return { settings, today };
  }

  // Everyone's entries (all kinds and states) that touch a date range.
  async function entriesAround(start, end) {
    const all = [];
    for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
      all.push(...(await db.listYearEntries(y)));
    }
    const seen = new Set();
    return all.filter((e) => e.start <= end && e.end >= start && !seen.has(e.id) && seen.add(e.id));
  }

  // A person's leave account as of today: all their entries since their account starts.
  async function accountFor(person, settings, today, { excludeId = null } = {}) {
    const from = person.snapshot?.asOf || rules.leaveAnchor(person, settings);
    const to = rules.addYears(today, 3);
    const [own, around] = await Promise.all([
      db.listUserEntries(person.userId, from, to),
      entriesAround(from < to ? from : to, to),
    ]);
    const entries = own.filter((e) => e.kind !== 'closure' && e.id !== excludeId);
    const closures = around.filter((e) => e.kind === 'closure');
    return { balance: rules.balance({ person, today, entries, closures, settings }), entries, closures };
  }

  // Closures around a date range (closures are practice-wide).
  async function closuresAround(start, end) {
    return (await entriesAround(start, end)).filter((e) => e.kind === 'closure');
  }

  function requireApprover(me) {
    if (!me.isApprover) throw new HttpError(403, 'Das darf nur, wer Urlaub genehmigt.');
  }

  function requirePlanner(me) {
    if (!me.canPlan) throw new HttpError(403, 'Das darf nur, wer für alle einträgt.');
  }

  // School and kindergarten holidays: entered by hand plus the free days from the
  // children's calendar.
  async function ferienList() {
    const stored = await db.getSettings();
    return [...(stored.ferien || []), ...(await kinderDays(stored))];
  }

  // The children's calendar is read again when the last read is older than this.
  const FEED_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  let feedRun = null; // one read at a time per Lambda instance

  async function kinderDays(stored, { force = false } = {}) {
    const feed = stored.kinderFeed;
    if (!feed?.url) return [];
    const cache = stored.kinderCache;
    const fresh = cache && cache.url === feed.url && now() - new Date(cache.fetchedAt) < FEED_MAX_AGE_MS;
    if (fresh && !force) return cache.items;
    if (!feedRun) {
      feedRun = (async () => {
        const next = { url: feed.url, fetchedAt: now().toISOString(), items: cache?.url === feed.url ? cache.items : [], error: '' };
        try {
          next.items = freeDaysFromIcs(await fetchText(feed.url), feed.words || DEFAULT_WORDS);
        } catch (err) {
          console.error('Children calendar failed', err?.name, err?.message);
          next.error = 'Der Kinder-Kalender konnte nicht gelesen werden. Es gelten die zuletzt gelesenen Tage.';
        }
        const latest = await db.getSettings();
        await db.putSettings({ ...latest, kinderCache: next }, {
          id: randomUUID(), at: now().toISOString(), actorId: 'system', action: 'kinder-abgleich', subjectUserId: '',
        });
        return next;
      })().finally(() => { feedRun = null; });
    }
    return (await feedRun).items;
  }

  // Blocked times (Sperrzeiten) of a person with sperrzeiten, around a date range.
  async function blockedFor(owner, start, end, extraFamily = null) {
    if (!owner.sperrzeiten) return new Map();
    const from = rules.addDays(start, -rules.FAMILY_BUFFER_DAYS);
    const to = rules.addDays(end, rules.FAMILY_BUFFER_DAYS);
    const [people, around, ferien] = await Promise.all([db.listPeople(), entriesAround(from, to), ferienList()]);
    const family = new Set(people.filter((p) => p.role === 'family' && p.active !== false).map((p) => p.userId));
    const familyEntries = around.filter((e) => family.has(e.userId) && e.id !== extraFamily?.id);
    if (extraFamily) familyEntries.push(extraFamily);
    return rules.blockedDays({ from: start, to: end, ferien, familyEntries });
  }

  // Days on which this entry would leave the owner's role below the minimum.
  async function warningsFor(entry, owner, settings) {
    let blockedText = '';
    if (owner.sperrzeiten && entry.kind === 'vacation') {
      const blocked = await blockedFor(owner, entry.start, entry.end);
      blockedText = rules.describeBlocked(entry, rules.normalizePattern(owner.workPattern), blocked);
    }
    if (!settings.minimumStaffing?.[owner.role]) return { warnings: [], warningText: blockedText };
    const [people, around] = await Promise.all([db.listPeople(), entriesAround(entry.start, entry.end)]);
    const warnings = rules.staffingWarnings({
      entry,
      owner,
      people,
      entries: around.filter((e) => e.kind !== 'closure'),
      closures: around.filter((e) => e.kind === 'closure'),
      settings,
    });
    return { warnings, warningText: [blockedText, rules.describeWarnings(warnings)].filter(Boolean).join(' ') };
  }

  // Emails never contain notes. A failed email never fails the request.
  async function send(to, subject, lines) {
    const recipients = [...new Set(to.filter(Boolean))];
    if (!notify || !recipients.length) return;
    try {
      await notify({ to: recipients, subject, text: [...lines, '', appUrl ? `Zum Planer: ${appUrl}` : ''].join('\n').trim() });
    } catch (err) {
      console.error('Email failed', err?.name, err?.message);
    }
  }

  function describeEntry(entry, owner) {
    const what = entry.kind === 'vacation' ? 'Urlaub' : (rules.REASONS[entry.reason] || 'Abwesenheit');
    const half = entry.half === 'am' ? ', Vormittag' : entry.half === 'pm' ? ', Nachmittag' : '';
    const days = entry.kind === 'vacation'
      ? ` (${rules.countEntry(entry, rules.normalizePattern(owner.workPattern)).total} Tage)`
      : '';
    return `${what}: ${rules.formatRange(entry.start, entry.end)}${half}${days}`;
  }

  async function tellApprovers(entry, owner, settings) {
    if (entry.status !== 'pending' || !notify) return;
    const people = await db.listPeople();
    const to = people
      .filter((p) => p.active !== false && p.approver && p.userId !== owner.userId)
      .map((p) => p.email);
    const { warningText } = await warningsFor(entry, owner, settings);
    await send(to, `Neuer Antrag von ${owner.name}`, [
      `${owner.name} hat einen Antrag gestellt.`,
      describeEntry(entry, owner),
      warningText ? `Achtung: ${warningText}` : '',
    ].filter(Boolean));
  }

  // The entry and its owner, if the caller may see it. Anything else is a 404.
  async function visibleEntry(id, me) {
    const entry = await db.getEntry(id);
    if (!entry) throw new HttpError(404, NOT_FOUND);
    if (entry.userId !== me.person.userId && !me.canPlan) throw new HttpError(404, NOT_FOUND);
    const owner = entry.userId === me.person.userId ? me.person : await db.getPerson(entry.userId);
    if (!owner) throw new HttpError(404, NOT_FOUND);
    return { entry, owner };
  }

  function readBody(req) {
    if (req.body === undefined || req.body === null) return {};
    if (typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new HttpError(400, 'Die Anfrage konnte nicht gelesen werden.');
    }
    return req.body;
  }

  async function validate(input, owner, id) {
    if (input.kind === 'closure') {
      throw new HttpError(400, 'Freie Tage für alle trägt ein, wer genehmigt (unter „Einstellungen“).');
    }
    const start = rules.isIsoDate(input.start) ? input.start : null;
    const end = rules.isIsoDate(input.end) ? input.end : start;
    let existing = [];
    let closures = [];
    if (start && end && end >= start && rules.spanDays(start, end) <= rules.MAX_SPAN_DAYS) {
      existing = await db.listUserEntries(owner.userId, start, end);
      closures = await closuresAround(start, end);
    }
    const result = rules.validateEntry(input, {
      existing: existing.filter((e) => e.kind !== 'closure'),
      pattern: rules.normalizePattern(owner.workPattern),
      closures,
      id,
    });
    if (result.error) return { ...result, closures };
    // Household staff can have a stand-in (Vertretung); shown in the overview and the feed.
    const substitute = owner.role === 'household' ? rules.validateSubstitute(input.substitute) : { value: '' };
    if (substitute.error) return { error: substitute.error, closures };
    return { value: { ...result.value, substitute: substitute.value }, closures };
  }

  function present(entry, owner, closures, { withNote }) {
    const pattern = rules.normalizePattern(owner.workPattern);
    const out = {
      id: entry.id,
      userId: entry.userId,
      kind: entry.kind,
      reason: entry.reason || '',
      start: entry.start,
      end: entry.end,
      half: entry.half || '',
      substitute: entry.substitute || '',
      status: entry.status,
      rev: entry.rev,
      days: entry.kind === 'vacation' ? rules.countEntry(entry, pattern, rules.closureDays(closures)).total : 0,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    if (withNote) {
      out.note = entry.note || '';
      out.decisionComment = entry.decisionComment || '';
    }
    return out;
  }

  function auditRecord(me, action, entry) {
    // Never put notes or tokens in the audit log.
    return {
      id: randomUUID(),
      at: now().toISOString(),
      actorId: me.person.userId,
      action,
      entryId: entry.id,
      subjectUserId: entry.userId,
      kind: entry.kind,
      start: entry.start,
      end: entry.end,
      half: entry.half || '',
      status: entry.status,
    };
  }

  // The family's own holiday needs no approval; it is information for everyone.
  function initialStatus(kind, settings, owner) {
    if (owner?.role === 'family') return 'approved';
    if (kind === 'absence' && !settings.absenceNeedsApproval) return 'approved';
    return 'pending';
  }

  function presentClosures(closures, settings) {
    const approved = closures.filter((c) => c.kind === 'closure' && c.status === 'approved');
    const closed = rules.closureDays(approved);
    return approved
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((c) => ({
        id: c.id,
        rev: c.rev,
        start: c.start,
        end: c.end,
        label: c.reason || '',
        substitute: c.substitute || '',
        countsAsVacation: !!c.countsAsVacation,
        reopens: rules.nextOpenDay(c.end, settings, closed),
      }));
  }

  function feedUrl(token) {
    return `${appUrl}feed/${token}.ics`;
  }

  function parseYear(value, today) {
    const year = value ? Number(value) : Number(today.slice(0, 4));
    if (!Number.isInteger(year) || year < 2020 || year > 2040) {
      throw new HttpError(400, 'Bitte wähle ein Jahr zwischen 2020 und 2040.');
    }
    return year;
  }

  // ----- routes -----

  async function overview(req) {
    const me = await caller(req);
    const { settings, today } = await context();
    const year = req.query?.year ? Number(req.query.year) : Number(today.slice(0, 4));
    if (!Number.isInteger(year) || year < 2020 || year > 2040) {
      throw new HttpError(400, 'Bitte wähle ein Jahr zwischen 2020 und 2040.');
    }
    // Approvers and the planner can open anyone's calendar.
    const wanted = typeof req.query?.userId === 'string' ? req.query.userId : '';
    let subject = me.person;
    if (wanted && wanted !== me.person.userId) {
      requirePlanner(me);
      subject = await db.getPerson(wanted);
      if (!subject || subject.active === false) throw new HttpError(404, 'Diese Person gibt es nicht.');
    }
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const [own, yearEntries, ferien, allPeople] = await Promise.all([
      db.listUserEntries(subject.userId, from, to),
      db.listYearEntries(year),
      ferienList(),
      db.listPeople(),
    ]);
    const closures = yearEntries.filter((e) => e.kind === 'closure');
    const entries = own
      .filter((e) => e.kind !== 'closure' && rules.ACTIVE_STATUSES.concat('declined').includes(e.status))
      .sort((a, b) => a.start.localeCompare(b.start));
    const pattern = rules.normalizePattern(subject.workPattern);
    const blocked = subject.sperrzeiten ? await blockedFor(subject, from, to) : new Map();
    const active = allPeople.filter((p) => p.active !== false);

    return {
      item: {
        year,
        today,
        me: {
          userId: me.person.userId,
          name: me.person.name,
          role: me.person.role,
          canApprove: me.isApprover,
          canPlan: me.canPlan,
          feedUrl: me.person.feed?.token ? feedUrl(me.person.feed.token) : '',
        },
        subject: {
          userId: subject.userId,
          name: subject.name,
          role: subject.role,
          roleLabel: rules.ROLES[subject.role] || '',
          job: subject.job || '',
          workPattern: pattern,
          sperrzeiten: !!subject.sperrzeiten,
          hasAccount: subject.role === 'household',
          rest: subject.rest || null,
        },
        practice: { name: settings.practiceName, openDays: settings.openDays },
        holidays: rules.publicHolidays(year),
        closures: presentClosures(closures, settings),
        ferien: ferien.filter((f) => f.end >= from && f.start <= to).sort((a, b) => a.start.localeCompare(b.start)),
        blocked: [...blocked].map(([date, b]) => ({ date, ...b })),
        entries: entries.map((e) => present(e, subject, closures, { withNote: true })),
        balance: (await accountFor(subject, settings, today)).balance,
        reasons: rules.REASONS,
        openRequests: me.canPlan ? await countOpenRequests(me, today) : 0,
        // Who can be picked: in the calendar and when entering for someone else.
        people: me.canPlan
          ? active.filter((p) => p.role !== 'office')
            .map((p) => ({ userId: p.userId, name: p.name, role: p.role, job: p.job || '' }))
            .sort((a, b) => Object.keys(rules.ROLES).indexOf(a.role) - Object.keys(rules.ROLES).indexOf(b.role)
              || a.name.localeCompare(b.name, 'de'))
          : [],
      },
    };
  }

  async function countOpenRequests(me, today) {
    const year = Number(today.slice(0, 4));
    const seen = new Set();
    const lists = await Promise.all([year - 1, year, year + 1].map((y) => db.listYearEntries(y)));
    return lists.flat().filter((e) => e.kind !== 'closure' && e.status === 'pending'
      && e.userId !== me.person.userId && !seen.has(e.id) && seen.add(e.id)).length;
  }

  // Live summary for the drawer: how many days, what is left afterwards. Never writes.
  async function check(req) {
    const me = await caller(req);
    const input = readBody(req);
    const id = typeof input.id === 'string' ? input.id : null;
    let owner;
    if (id) ({ owner } = await visibleEntry(id, me));
    else owner = await targetOwner(me, input);
    const { settings, today } = await context();
    const { value, error, closures } = await validate(input, owner, id);
    if (error) return { item: { ok: false, error } };

    const pattern = rules.normalizePattern(owner.workPattern);
    const days = value.kind === 'vacation' ? rules.countEntry(value, pattern, rules.closureDays(closures)).total : 0;
    const { balance } = await accountFor(owner, settings, today, { excludeId: id });
    const { warnings, warningText } = await warningsFor({ ...value, id }, owner, settings);
    return {
      item: {
        ok: true, days, remainingAfter: balance.remaining - balance.pending - days, warnings, warningText,
      },
    };
  }

  // Whose entry this is: the caller, or (approvers and planner) another active person.
  async function targetOwner(me, input) {
    const userId = typeof input.userId === 'string' ? input.userId : '';
    if (!userId || userId === me.person.userId) return me.person;
    requirePlanner(me);
    const person = await db.getPerson(userId);
    if (!person || person.active === false) throw new HttpError(404, 'Diese Person gibt es nicht.');
    return person;
  }

  async function createEntry(req) {
    const me = await caller(req);
    const input = readBody(req);
    const owner = await targetOwner(me, input);
    const { settings } = await context();
    const { value, error, closures } = await validate(input, owner, null);
    if (error) throw new HttpError(400, error);
    const at = now().toISOString();
    // Approvers can enter leave that was already agreed (e.g. when the planner starts).
    const agreed = me.isApprover && input.approved === true;
    const entry = {
      id: randomUUID(),
      userId: owner.userId,
      ...value,
      status: agreed ? 'approved' : initialStatus(value.kind, settings, owner),
      ...(agreed ? { decidedBy: me.person.userId, decidedAt: at } : {}),
      rev: 1,
      createdAt: at,
      updatedAt: at,
    };
    await db.createEntry(entry, auditRecord(me, agreed ? 'create-approved' : 'create', entry));
    await tellApprovers(entry, owner, settings);
    return { created: true, item: present(entry, owner, closures, { withNote: true }) };
  }

  async function getEntry(req, id) {
    const me = await caller(req);
    const { entry, owner } = await visibleEntry(id, me);
    const closures = await closuresAround(entry.start, entry.end);
    return { item: present(entry, owner, closures, { withNote: true }) };
  }

  function guardPast(entry, me, today) {
    if (!me.canPlan && entry.status === 'approved' && entry.start < today) {
      throw new HttpError(403, 'Dieser Eintrag hat schon begonnen. Änderungen macht, wer für alle einträgt.');
    }
  }

  function expectedRev(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new HttpError(400, 'Es fehlt die Versionsnummer. Bitte lade die Seite neu.');
    }
    return n;
  }

  async function updateEntry(req, id) {
    const me = await caller(req);
    const input = readBody(req);
    const { entry, owner } = await visibleEntry(id, me);
    if (entry.kind === 'closure') throw new HttpError(404, NOT_FOUND);
    const rev = expectedRev(input.expectedRev);
    if (rev !== entry.rev) throw new ConflictError();
    const { settings, today } = await context();
    guardPast(entry, me, today);

    const { value, error, closures } = await validate(input, owner, id);
    if (error) throw new HttpError(400, error);

    const datesChanged = ['kind', 'reason', 'start', 'end', 'half'].some((k) => (entry[k] || '') !== value[k]);
    let status = entry.status;
    if (datesChanged && status !== 'pending') status = initialStatus(value.kind, settings, owner);
    const next = { ...entry, ...value, status, rev: entry.rev + 1, updatedAt: now().toISOString() };
    if (datesChanged) {
      delete next.decidedBy;
      delete next.decidedAt;
      delete next.decisionComment;
    }
    await db.updateEntry(next, rev, auditRecord(me, 'update', next));
    if (status === 'pending' && datesChanged) await tellApprovers(next, owner, settings);
    return { item: present(next, owner, closures, { withNote: true }) };
  }

  async function deleteEntry(req, id) {
    const me = await caller(req);
    const { entry } = await visibleEntry(id, me);
    if (entry.kind === 'closure') throw new HttpError(404, NOT_FOUND);
    const rev = expectedRev(req.query?.rev);
    if (rev !== entry.rev) throw new ConflictError();
    const { today } = await context();
    guardPast(entry, me, today);
    await db.deleteEntry(id, rev, auditRecord(me, 'delete', entry));
    return { item: { id, deleted: true } };
  }

  // Month timeline for everyone: names, dates, type and status. Never notes.
  async function team(req) {
    const me = await caller(req);
    const { settings, today } = await context();
    const month = typeof req.query?.month === 'string' ? req.query.month : today.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2020-01' || month > '2040-12') {
      throw new HttpError(400, 'Bitte wähle einen Monat zwischen 2020 und 2040.');
    }
    const first = `${month}-01`;
    const last = rules.addDays(rules.addDays(first, 32).slice(0, 7) + '-01', -1);
    const dates = [];
    rules.eachDay(first, last, (d) => dates.push(d));

    const [people, around, ferien] = await Promise.all([
      db.listPeople(), entriesAround(rules.addDays(first, -rules.FAMILY_BUFFER_DAYS), rules.addDays(last, rules.FAMILY_BUFFER_DAYS)), ferienList(),
    ]);
    // The assistant (office) organises; she is not part of the calendar.
    const active = people.filter((p) => p.active !== false && p.role !== 'office');
    const familyEntries = around.filter((e) => active.some((p) => p.userId === e.userId && p.role === 'family'));
    const blocked = rules.blockedDays({ from: first, to: last, ferien, familyEntries });
    const closures = around.filter((e) => e.kind === 'closure');
    const entries = around.filter((e) => e.kind !== 'closure' && rules.ACTIVE_STATUSES.includes(e.status)
      && e.start <= last && e.end >= first && active.some((p) => p.userId === e.userId));
    const approved = rules.staffing({ dates, people: active, entries: entries.filter((e) => e.status === 'approved'), closures, settings });
    const planned = rules.staffing({ dates, people: active, entries, closures, settings });
    const roleOrder = Object.keys(rules.ROLES);
    // Leave accounts of the household staff, for the summary on top (not for staff logins).
    const balances = {};
    if (me.canPlan) {
      for (const p of active.filter((x) => x.role === 'household')) {
        balances[p.userId] = (await accountFor(p, settings, today)).balance;
      }
    }

    return {
      item: {
        month,
        balances,
        today,
        me: { userId: me.person.userId, canApprove: me.isApprover, canPlan: me.canPlan },
        ferienKinds: rules.FERIEN_KINDS,
        ferien: ferien.filter((f) => f.start <= last && f.end >= first),
        blocked: [...blocked].map(([date, b]) => ({ date, ...b })),
        roles: rules.ROLES,
        reasons: rules.REASONS,
        minimumStaffing: settings.minimumStaffing,
        people: active
          .map((p) => ({
            userId: p.userId, name: p.name, role: p.role, job: p.job || '', sperrzeiten: !!p.sperrzeiten,
            workPattern: rules.normalizePattern(p.workPattern),
          }))
          .sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.name.localeCompare(b.name, 'de')),
        entries: entries.map((e) => ({
          id: e.id, userId: e.userId, kind: e.kind, reason: e.reason || '', start: e.start, end: e.end, half: e.half || '',
          status: e.status, substitute: e.substitute || '',
        })),
        holidays: dates.filter((d) => rules.holidayName(d)).map((d) => ({ date: d, name: rules.holidayName(d) })),
        closures: presentClosures(closures, settings),
        days: dates.map((d) => ({
          date: d,
          open: approved.get(d).open,
          roles: approved.get(d).roles,
          below: approved.get(d).below,
          belowIfApproved: planned.get(d).below,
        })),
      },
    };
  }

  // Approvers: everything waiting for a decision, oldest request first, with staffing warnings.
  async function requests(req) {
    const me = await caller(req);
    requirePlanner(me);
    const { settings, today } = await context();
    const year = Number(today.slice(0, 4));
    const [people, ...years] = await Promise.all([
      db.listPeople(),
      ...[year - 1, year, year + 1].map((y) => db.listYearEntries(y)),
    ]);
    const seen = new Set();
    const pending = years.flat()
      .filter((e) => e.kind !== 'closure' && e.status === 'pending' && !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const items = [];
    for (const e of pending) {
      const owner = people.find((p) => p.userId === e.userId);
      if (!owner) continue;
      const closures = await closuresAround(e.start, e.end);
      items.push({
        ...present(e, owner, closures, { withNote: true }),
        name: owner.name,
        job: owner.job || '',
        role: owner.role,
        roleLabel: rules.ROLES[owner.role] || '',
        isOwn: owner.userId === me.person.userId,
        canDecide: me.isApprover && owner.userId !== me.person.userId,
        ...(await warningsFor(e, owner, settings)),
      });
    }
    return { item: { today, reasons: rules.REASONS, canApprove: me.isApprover, requests: items } };
  }

  async function decide(req, id) {
    const me = await caller(req);
    requireApprover(me);
    const input = readBody(req);
    const { entry, owner } = await visibleEntry(id, me);
    if (entry.kind === 'closure') throw new HttpError(404, NOT_FOUND);
    if (!['approved', 'declined'].includes(input.status)) {
      throw new HttpError(400, 'Bitte wähle Bestätigen oder Ablehnen.');
    }
    const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
    if (comment.length > rules.NOTE_MAX) {
      throw new HttpError(400, `Der Kommentar darf höchstens ${rules.NOTE_MAX} Zeichen haben.`);
    }
    if (owner.userId === me.person.userId) {
      throw new HttpError(403, 'Den eigenen Antrag bestätigt die andere Person.');
    }
    const rev = expectedRev(input.expectedRev);
    if (rev !== entry.rev) throw new ConflictError();
    if (entry.status !== 'pending') {
      throw new HttpError(409, 'Über diesen Antrag wurde schon entschieden. Bitte lade die Seite neu.');
    }
    const at = now().toISOString();
    const next = {
      ...entry,
      status: input.status,
      decidedBy: me.person.userId,
      decidedAt: at,
      decisionComment: comment,
      rev: entry.rev + 1,
      updatedAt: at,
    };
    await db.updateEntry(next, rev, auditRecord(me, input.status === 'approved' ? 'approve' : 'decline', next));
    const word = input.status === 'approved' ? 'bestätigt' : 'abgelehnt';
    await send([owner.email], `Dein Antrag wurde ${word}`, [
      `${me.person.name} hat deinen Antrag ${word}.`,
      describeEntry(next, owner),
      comment ? `Kommentar: ${comment}` : '',
    ].filter(Boolean));
    const closures = await closuresAround(entry.start, entry.end);
    return { item: present(next, owner, closures, { withNote: true }) };
  }

  // ----- school and kindergarten holidays (wer genehmigt oder für alle einträgt) -----
  // Kept as a list in the settings record, so they never mix with anyone's leave.

  const FERIEN_NOT_FOUND = 'Diese Ferien gibt es nicht (mehr).';

  async function saveFerien(me, list, action) {
    const stored = await db.getSettings();
    list.sort((a, b) => a.start.localeCompare(b.start));
    await db.putSettings({ ...stored, ferien: list }, simpleAudit(me, action, ''));
    return list;
  }

  async function createFerien(req) {
    const me = await caller(req);
    requirePlanner(me);
    const { value, error } = rules.validateFerien(readBody(req));
    if (error) throw new HttpError(400, error);
    const list = (await db.getSettings()).ferien || [];
    const item = { id: randomUUID(), ...value };
    await saveFerien(me, [...list, item], 'ferien-create');
    return { created: true, item };
  }

  async function updateFerien(req, id) {
    const me = await caller(req);
    requirePlanner(me);
    const list = (await db.getSettings()).ferien || [];
    if (!list.some((f) => f.id === id)) throw new HttpError(404, FERIEN_NOT_FOUND);
    const { value, error } = rules.validateFerien(readBody(req));
    if (error) throw new HttpError(400, error);
    const item = { id, ...value };
    await saveFerien(me, list.map((f) => (f.id === id ? item : f)), 'ferien-update');
    return { item };
  }

  async function deleteFerien(req, id) {
    const me = await caller(req);
    requirePlanner(me);
    const list = (await db.getSettings()).ferien || [];
    if (!list.some((f) => f.id === id)) throw new HttpError(404, FERIEN_NOT_FOUND);
    await saveFerien(me, list.filter((f) => f.id !== id), 'ferien-delete');
    return { item: { id, deleted: true } };
  }

  // ----- the children's calendar (approvers set the link, planner can sync) -----

  function presentFeed(stored) {
    const feed = stored.kinderFeed || {};
    const cache = feed.url && stored.kinderCache?.url === feed.url ? stored.kinderCache : null;
    return {
      url: feed.url || '',
      words: { ...DEFAULT_WORDS, ...(feed.words || {}) },
      fetchedAt: cache?.fetchedAt || '',
      count: cache ? cache.items.length : 0,
      error: cache?.error || '',
    };
  }

  async function putKinderFeed(req) {
    const me = await caller(req);
    requireApprover(me);
    const input = readBody(req);
    const url = normalizeFeedUrl(input.url);
    if (url.error) throw new HttpError(400, url.error);
    const words = {};
    for (const k of Object.keys(DEFAULT_WORDS)) {
      const r = typeof input.words?.[k] === 'string' ? input.words[k].trim() : DEFAULT_WORDS[k];
      if (r.length > 500) throw new HttpError(400, 'Die Wörter sind zu lang (höchstens 500 Zeichen).');
      words[k] = r;
    }
    const stored = await db.getSettings();
    const next = { ...stored, kinderFeed: url.value ? { url: url.value, words } : null };
    await db.putSettings(next, simpleAudit(me, 'kinder-kalender', ''));
    if (url.value) await kinderDays(next, { force: true });
    return { item: presentFeed(await db.getSettings()) };
  }

  async function syncKinderFeed(req) {
    const me = await caller(req);
    requirePlanner(me);
    const stored = await db.getSettings();
    if (!stored.kinderFeed?.url) throw new HttpError(400, 'Es ist noch kein Kinder-Kalender verbunden.');
    await kinderDays(stored, { force: true });
    const after = presentFeed(await db.getSettings());
    return { item: { fetchedAt: after.fetchedAt, count: after.count, error: after.error } };
  }

  // ----- practice closures (approvers) -----

  const CLOSURE_NOT_FOUND = 'Diese freien Tage gibt es nicht (mehr).';

  async function closureById(id) {
    const entry = await db.getEntry(id);
    if (!entry || entry.kind !== 'closure') throw new HttpError(404, CLOSURE_NOT_FOUND);
    return entry;
  }

  async function createClosure(req) {
    const me = await caller(req);
    requireApprover(me);
    const { value, error } = rules.validateClosure(readBody(req));
    if (error) throw new HttpError(400, error);
    const { settings } = await context();
    const at = now().toISOString();
    const entry = {
      id: randomUUID(), userId: me.person.userId, ...value, note: '', status: 'approved', rev: 1, createdAt: at, updatedAt: at,
    };
    await db.createEntry(entry, auditRecord(me, 'create', entry));
    return { created: true, item: presentClosures([entry], settings)[0] };
  }

  async function updateClosure(req, id) {
    const me = await caller(req);
    requireApprover(me);
    const input = readBody(req);
    const entry = await closureById(id);
    const rev = expectedRev(input.expectedRev);
    if (rev !== entry.rev) throw new ConflictError();
    const { value, error } = rules.validateClosure(input);
    if (error) throw new HttpError(400, error);
    const { settings } = await context();
    const next = { ...entry, ...value, rev: entry.rev + 1, updatedAt: now().toISOString() };
    await db.updateEntry(next, rev, auditRecord(me, 'update', next));
    return { item: presentClosures([next], settings)[0] };
  }

  async function deleteClosure(req, id) {
    const me = await caller(req);
    requireApprover(me);
    const entry = await closureById(id);
    const rev = expectedRev(req.query?.rev);
    if (rev !== entry.rev) throw new ConflictError();
    await db.deleteEntry(id, rev, auditRecord(me, 'delete', entry));
    return { item: { id, deleted: true } };
  }

  // ----- practice settings (approvers) -----

  function presentSettings(settings) {
    return {
      kinderFeed: presentFeed(settings),
      practiceName: settings.practiceName,
      openDays: settings.openDays,
      minimumStaffing: settings.minimumStaffing,
      defaultAllowance: settings.defaultAllowance,
      absenceNeedsApproval: settings.absenceNeedsApproval,
      roles: rules.ROLES,
      mailEnabled: !!notify,
    };
  }

  // Approvers check that request emails arrive: one test mail to their own address.
  async function mailTest(req) {
    const me = await caller(req);
    requireApprover(me);
    if (!notify) throw new HttpError(400, 'E-Mails sind noch nicht eingeschaltet. Siehe Anleitung „E-Mails einschalten“.');
    if (!me.person.email) throw new HttpError(400, 'Bei dir ist keine E-Mail-Adresse hinterlegt. Trag sie unter Team bei deinem Namen ein.');
    try {
      await notify({
        to: [me.person.email],
        subject: 'Test vom Urlaubsplaner',
        text: `Hallo ${me.person.name},\n\ndiese Test-Mail ist angekommen. Bei neuen Anträgen bekommst du ab jetzt eine Nachricht.${appUrl ? `\n\nZum Planer: ${appUrl}` : ''}`,
      });
    } catch (err) {
      console.error('Test mail failed', err?.name, err?.message);
      throw new HttpError(502, 'Die Test-Mail konnte nicht gesendet werden. Meist sind die 3 DNS-Einträge für die Absender-Domain noch nicht eingetragen oder noch nicht aktiv (das kann bis zu 72 Stunden dauern).');
    }
    return { item: { sentTo: me.person.email } };
  }

  async function getSettings(req) {
    const me = await caller(req);
    requireApprover(me);
    const { settings } = await context();
    return { item: presentSettings(settings) };
  }

  async function putSettings(req) {
    const me = await caller(req);
    requireApprover(me);
    const { settings } = await context();
    const { value, error } = rules.validateSettings(readBody(req), settings);
    if (error) throw new HttpError(400, error);
    await db.putSettings({ ...(await db.getSettings()), ...value }, simpleAudit(me, 'settings', ''));
    return { item: presentSettings({ ...settings, ...value }) };
  }

  // ----- people (approvers) -----

  function simpleAudit(me, action, subjectUserId) {
    return { id: randomUUID(), at: now().toISOString(), actorId: me.person.userId, action, subjectUserId };
  }

  async function presentPerson(person, today, settings) {
    const b = (await accountFor(person, settings, today)).balance;
    return {
      userId: person.userId,
      username: person.username || '',
      name: person.name,
      email: person.email || '',
      role: person.role,
      roleLabel: rules.ROLES[person.role] || '',
      active: person.active !== false,
      login: person.login !== false,
      approver: !!person.approver,
      planner: !!person.planner,
      job: person.job || '',
      sperrzeiten: !!person.sperrzeiten,
      rest: person.rest || null,
      workPattern: rules.normalizePattern(person.workPattern),
      startDate: person.startDate || '',
      defaultAllowance: rules.defaultAllowance(person.workPattern, settings.defaultAllowance),
      allowanceOverride: typeof person.allowances?.[b.yearStart] === 'number' ? person.allowances[b.yearStart] : null,
      extraDays: Number(person.extraDays) || 0,
      extraNote: person.extraNote || '',
      balance: b,
    };
  }

  async function listPeople(req) {
    const me = await caller(req);
    requirePlanner(me);
    const { settings, today } = await context();
    const year = parseYear(req.query?.year, today);
    const roleOrder = Object.keys(rules.ROLES);
    const people = (await db.listPeople())
      .sort((a, b) => (a.active === false) - (b.active === false)
        || roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.name.localeCompare(b.name, 'de'));
    const items = [];
    for (const p of people) items.push(await presentPerson(p, today, settings));
    return { item: { year, today, roles: rules.ROLES, canApprove: me.isApprover, people: items } };
  }

  function requireDirectory() {
    if (!directory) {
      throw new HttpError(501, 'Das geht in dieser Umgebung nicht. Bitte `npm run user:add` verwenden.');
    }
  }

  // Group in the login system: approver (the parents), planner (the assistant) or staff.
  const groupOf = (p) => (p.approver ? 'approver' : p.planner ? 'planner' : 'staff');

  async function addPerson(req) {
    const me = await caller(req);
    requirePlanner(me);
    const { value, error } = rules.validateNewPerson(readBody(req));
    if (error) throw new HttpError(400, error);
    // Only approvers hand out logins.
    if (value.login) requireApprover(me);
    const people = await db.listPeople();
    let userId = `ohne-zugang-${randomUUID()}`;
    let startPassword = '';
    if (value.login) {
      requireDirectory();
      if (people.some((p) => p.username === value.username)) {
        throw new HttpError(409, `Den Benutzernamen „${value.username}“ gibt es schon. Bitte wähle einen anderen.`);
      }
      ({ userId, startPassword } = await directory.createUser({
        username: value.username, email: value.email, group: groupOf(value),
      }));
    }
    const person = {
      userId,
      username: value.username,
      name: value.name,
      email: value.email,
      role: value.role,
      active: true,
      login: value.login,
      approver: value.approver,
      planner: value.planner,
      ...(value.job ? { job: value.job } : {}),
      ...(value.sperrzeiten ? { sperrzeiten: true } : {}),
      workPattern: value.workPattern,
      allowances: {},
      startDate: value.startDate,
      updatedAt: now().toISOString(),
    };
    await db.putPerson(person, simpleAudit(me, 'person-create', userId));
    const { settings, today } = await context();
    return {
      created: true,
      item: { person: await presentPerson(person, today, settings), startPassword },
    };
  }

  async function updatePerson(req, userId) {
    const me = await caller(req);
    requirePlanner(me);
    const input = readBody(req);
    const person = await db.getPerson(userId);
    if (!person) throw new HttpError(404, 'Diese Person gibt es nicht.');
    const { value, error } = rules.validatePersonUpdate(input, person);
    if (error) throw new HttpError(400, error);
    const self = userId === me.person.userId;
    if (self && value.active === false) throw new HttpError(400, 'Du kannst dich nicht selbst deaktivieren.');
    if (self && (input.approver === false || input.planner === false)) {
      throw new HttpError(400, 'Deine eigenen Rechte kannst du nicht selbst ändern.');
    }
    const hasLogin = person.login !== false;
    const enabledChanged = (person.active !== false) !== (value.active !== false);
    const approverChanged = typeof input.approver === 'boolean' && input.approver !== !!person.approver;
    const plannerChanged = typeof input.planner === 'boolean' && input.planner !== !!person.planner;
    if (hasLogin && (enabledChanged || approverChanged || plannerChanged)) {
      requireApprover(me);
      requireDirectory();
    }
    if (!hasLogin && (approverChanged || plannerChanged)) {
      throw new HttpError(400, 'Diese Person hat keinen Zugang und kann deshalb nichts genehmigen oder eintragen.');
    }
    const before = groupOf(person);
    if (approverChanged) value.approver = input.approver;
    if (plannerChanged) value.planner = input.planner;
    if (value.approver) value.planner = false;
    if (hasLogin && enabledChanged) await directory.setEnabled(person.username, value.active !== false);
    if (hasLogin && groupOf(value) !== before) await directory.setGroup(person.username, groupOf(value), before);
    value.updatedAt = now().toISOString();
    await db.putPerson(value, simpleAudit(me, 'person-update', userId));
    const { settings, today } = await context();
    return { item: await presentPerson(value, today, settings) };
  }

  // ----- taking over existing leave plans (approvers) -----

  // Body: { dryRun, people: [{ username or name, create, role, job, startDate, workPattern,
  //                           sperrzeiten, restDays, restAsOf, extraDays, extraNote }],
  //         closures: [{ start, end, label, countsAsVacation }],
  //         entries: [{ username, kind, reason, start, end, half, note }] }
  // Entries are saved as approved. Nothing is written when dryRun is true (the default).
  // Rows that already exist are skipped, so running it twice does no harm.
  async function importData(req) {
    const me = await caller(req);
    requirePlanner(me);
    const input = readBody(req);
    const dryRun = input.dryRun !== false;
    const list = (key) => (Array.isArray(input[key]) ? input[key] : []);
    if (list('people').length + list('closures').length + list('entries').length > 1000) {
      throw new HttpError(400, 'Bitte höchstens 1000 Zeilen auf einmal übernehmen.');
    }
    const at = now().toISOString();
    const report = { dryRun, people: [], closures: [], entries: [], skipped: [], problems: [] };
    // People without a login are found by their name.
    const keyOf = (p) => (p.username ? p.username.toLowerCase() : `name:${String(p.name || '').trim().toLocaleLowerCase('de')}`);
    const byUsername = new Map((await db.listPeople()).map((p) => [keyOf(p), p]));
    const lookup = (row) => keyOf({ username: row?.username, name: row?.name });

    for (const row of list('people')) {
      const key = lookup(row);
      let person = byUsername.get(key);
      if (!person && row?.create === true && !row.username) {
        // A new person without a login, e.g. household staff.
        const fresh = rules.validateNewPerson({ ...row, login: false, role: row.role || 'household' });
        if (fresh.error) {
          report.problems.push(`${row.name || '?'}: ${fresh.error}`);
          continue;
        }
        person = {
          userId: `ohne-zugang-${randomUUID()}`, username: '', name: fresh.value.name, email: '', role: fresh.value.role,
          active: true, login: false, approver: false, planner: false, workPattern: fresh.value.workPattern, allowances: {},
        };
      }
      if (!person) {
        report.problems.push(`„${row?.username || row?.name}“ gibt es im Planer nicht. Bitte zuerst unter Einstellungen anlegen.`);
        continue;
      }
      const changes = {};
      for (const k of ['startDate', 'workPattern', 'extraDays', 'extraNote', 'job', 'sperrzeiten']) if (row[k] !== undefined) changes[k] = row[k];
      let { value, error } = rules.validatePersonUpdate(changes, person);
      if (!error && row.restDays !== undefined) {
        ({ value, error } = rules.validatePersonUpdate({ restDays: row.restDays, restAsOf: row.restAsOf }, value));
      }
      if (error) {
        report.problems.push(`${person.name}: ${error}`);
        continue;
      }
      value.updatedAt = at;
      report.people.push(`${person.name}${byUsername.has(key) ? '' : ' (neu, ohne Zugang)'}: `
        + `Eintritt ${value.startDate ? rules.formatDay(value.startDate) : '–'}, `
        + `${rules.normalizePattern(value.workPattern).length} Tage pro Woche`
        + `${value.rest ? `, Resturlaub ${String(value.rest.days).replace('.', ',')} Tage am ${rules.formatDay(value.rest.asOf)}` : ''}`
        + `${value.sperrzeiten ? ', mit Sperrzeiten' : ''}`
        + `${value.extraDays ? `, Korrektur ${value.extraDays > 0 ? '+' : ''}${value.extraDays}` : ''}`);
      if (!dryRun) await db.putPerson(value, simpleAudit(me, 'person-import', person.userId));
      byUsername.set(key, value);
    }

    const rows = list('entries');
    const dates = [...list('closures'), ...rows].flatMap((r) => [r?.start, r?.end || r?.start]).filter(rules.isIsoDate).sort();
    const known = dates.length ? (await entriesAround(dates[0], dates.at(-1))).filter((e) => e.kind === 'closure') : [];
    const closures = [...known];

    for (const row of list('closures')) {
      const { value, error } = rules.validateClosure(row);
      const label = rules.isIsoDate(row?.start) ? rules.formatRange(row.start, row.end || row.start) : 'Betriebsurlaub';
      if (error) {
        report.problems.push(`Betriebsurlaub ${label}: ${error}`);
        continue;
      }
      if (closures.some((c) => c.start === value.start && c.end === value.end)) {
        report.skipped.push(`Betriebsurlaub ${label} ist schon eingetragen.`);
        continue;
      }
      const entry = { id: randomUUID(), userId: me.person.userId, ...value, note: '', status: 'approved', rev: 1, createdAt: at, updatedAt: at };
      closures.push(entry);
      report.closures.push(`${label}${value.reason ? ` (${value.reason})` : ''}`);
      if (!dryRun) await db.createEntry(entry, auditRecord(me, 'import', entry));
    }

    const added = new Map(); // userId → entries created in this run
    for (const row of rows) {
      const owner = byUsername.get(lookup(row));
      if (!owner) {
        report.problems.push(`„${row?.username || row?.name}“ gibt es im Planer nicht. Bitte zuerst unter Einstellungen anlegen.`);
        continue;
      }
      const { value, error } = rules.validateEntry({ kind: 'vacation', ...row }, { pattern: rules.normalizePattern(owner.workPattern), closures });
      const label = rules.isIsoDate(row?.start) ? rules.formatRange(row.start, row.end || row.start) : '?';
      if (error) {
        report.problems.push(`${owner.name}, ${label}: ${error}`);
        continue;
      }
      const existing = [
        ...(await db.listUserEntries(owner.userId, value.start, value.end)).filter((e) => e.kind !== 'closure'),
        ...(added.get(owner.userId) || []),
      ].filter((e) => rules.ACTIVE_STATUSES.includes(e.status));
      if (existing.some((e) => e.start === value.start && e.end === value.end && (e.half || '') === value.half && e.kind === value.kind)) {
        report.skipped.push(`${owner.name}, ${label} ist schon eingetragen.`);
        continue;
      }
      const clash = rules.validateEntry(value, { existing, pattern: rules.normalizePattern(owner.workPattern), closures });
      if (clash.error) {
        report.problems.push(`${owner.name}, ${label}: ${clash.error}`);
        continue;
      }
      const entry = {
        id: randomUUID(), userId: owner.userId, ...value, substitute: '', status: 'approved',
        decidedBy: me.person.userId, decidedAt: at, rev: 1, createdAt: at, updatedAt: at,
      };
      if (!added.has(owner.userId)) added.set(owner.userId, []);
      added.get(owner.userId).push(entry);
      const days = value.kind === 'vacation'
        ? rules.countEntry(value, rules.normalizePattern(owner.workPattern), rules.closureDays(closures)).total : 0;
      report.entries.push(`${owner.name}, ${label}${value.kind === 'vacation' ? ` (${String(days).replace('.', ',')} ${days === 1 ? 'Tag' : 'Tage'})` : ''}`);
      if (!dryRun) await db.createEntry(entry, auditRecord(me, 'import', entry));
    }
    return { item: report };
  }

  // ----- export and calendar feed -----

  async function ownYear(me, year) {
    const own = await db.listUserEntries(me.person.userId, `${year}-01-01`, `${year}-12-31`);
    return own.filter((e) => e.kind !== 'closure').sort((a, b) => a.start.localeCompare(b.start));
  }

  function entryTitle(e) {
    const what = e.kind === 'vacation' ? 'Urlaub' : (rules.REASONS[e.reason] || 'Abwesenheit');
    const half = e.half === 'am' ? ' (Vormittag)' : e.half === 'pm' ? ' (Nachmittag)' : '';
    return `${what}${half}`;
  }

  async function exportIcs(req) {
    const me = await caller(req);
    const { today } = await context();
    const year = parseYear(req.query?.year, today);
    const entries = (await ownYear(me, year)).filter((e) => rules.ACTIVE_STATUSES.includes(e.status));
    const raw = calendar({
      name: `Meine Abwesenheiten ${year}`,
      events: entries.map((e) => ({
        uid: `${e.id}@urlaubsplaner`,
        start: e.start,
        end: e.end,
        half: e.half,
        summary: `${entryTitle(e)}${e.status === 'pending' ? ' – beantragt' : ''}`,
        description: [e.note, e.substitute ? `Vertretung: ${e.substitute}` : ''].filter(Boolean).join('\n'),
        updatedAt: e.updatedAt,
      })),
    });
    return { raw, contentType: 'text/calendar; charset=utf-8', filename: `abwesenheiten-${year}.ics` };
  }

  async function exportCsv(req) {
    const me = await caller(req);
    const { today } = await context();
    const year = parseYear(req.query?.year, today);
    const entries = await ownYear(me, year);
    const closures = (await db.listYearEntries(year)).filter((e) => e.kind === 'closure');
    const pattern = rules.normalizePattern(me.person.workPattern);
    const closed = rules.closureDays(closures);
    const at = (iso) => iso.split('-').reverse().join('.');
    const status = { pending: 'beantragt', approved: 'bestätigt', declined: 'abgelehnt' };
    const rows = [['Von', 'Bis', 'Art', 'Halber Tag', 'Urlaubstage', 'Status', 'Notiz', 'Kommentar zur Entscheidung']];
    for (const e of entries) {
      rows.push([
        at(e.start),
        at(e.end),
        e.kind === 'vacation' ? 'Urlaub' : (rules.REASONS[e.reason] || 'Abwesenheit'),
        e.half === 'am' ? 'Vormittag' : e.half === 'pm' ? 'Nachmittag' : '',
        e.kind === 'vacation' ? String(rules.countEntry(e, pattern, closed).total).replace('.', ',') : '0',
        status[e.status] || e.status,
        e.note || '',
        e.decisionComment || '',
      ]);
    }
    return { raw: toCsv(rows), contentType: 'text/csv; charset=utf-8', filename: `abwesenheiten-${year}.csv` };
  }

  // The random token is the credential: shown only to its owner, replaceable, removable.
  async function createFeed(req) {
    const me = await caller(req);
    const token = randomBytes(24).toString('base64url'); // 32 characters
    const person = { ...me.person, feed: { token, createdAt: now().toISOString() }, updatedAt: now().toISOString() };
    await db.putPerson(person, simpleAudit(me, 'feed-create', me.person.userId));
    return { item: { url: feedUrl(token) } };
  }

  async function deleteFeed(req) {
    const me = await caller(req);
    const { feed, ...rest } = me.person;
    await db.putPerson({ ...rest, updatedAt: now().toISOString() }, simpleAudit(me, 'feed-delete', me.person.userId));
    return { item: { deleted: true } };
  }

  // Anonymous: calendar apps cannot sign in. Any problem answers a plain 404.
  async function feedResponse(token) {
    const notFound = { status: 404, raw: 'Not found', contentType: 'text/plain; charset=utf-8' };
    if (!token) return notFound;
    try {
      const people = await db.listPeople();
      const wanted = Buffer.from(token);
      const owner = people.find((p) => {
        const have = Buffer.from(p.feed?.token || '');
        return have.length === wanted.length && timingSafeEqual(have, wanted);
      });
      if (!owner || owner.active === false) return notFound;

      const { settings, today } = await context();
      const from = `${rules.addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`; // first of last month
      const to = rules.addDays(from, 14 * 31);
      const active = new Map(people.filter((p) => p.active !== false).map((p) => [p.userId, p]));
      const around = await entriesAround(from, to);
      const events = [];
      for (const e of around) {
        if (e.status !== 'approved') continue;
        if (e.kind === 'closure') {
          events.push({
            uid: `${e.id}@urlaubsplaner`, start: e.start, end: e.end, half: '',
            summary: `${settings.practiceName}: alle frei${e.reason ? ` (${e.reason})` : ''}`,
            description: e.substitute ? `Vertretung: ${e.substitute}` : '',
            updatedAt: e.updatedAt,
          });
          continue;
        }
        const p = active.get(e.userId);
        if (!p) continue;
        events.push({
          uid: `${e.id}@urlaubsplaner`, start: e.start, end: e.end, half: e.half,
          summary: `${p.name}: ${entryTitle(e)}`,
          description: e.substitute ? `Vertretung: ${e.substitute}` : '', // never the note
          updatedAt: e.updatedAt,
        });
      }
      events.sort((a, b) => a.start.localeCompare(b.start));
      return {
        status: 200,
        raw: calendar({ name: `${settings.practiceName} – Abwesenheiten`, events }),
        contentType: 'text/calendar; charset=utf-8',
      };
    } catch (err) {
      console.error('Feed failed', err?.name, err?.message);
      return notFound;
    }
  }

  // ----- yearly retention -----

  // Keeps the current year and the two before it; deletes older entries and audit records.
  async function runRetention() {
    const { today } = await context();
    const year = Number(today.slice(0, 4));
    const cutoff = `${year - 2}-01-01`;
    const system = { person: { userId: 'system' } };
    const { settings } = await context();
    // First keep each person's account at the cutoff, so deleting old entries changes no balance.
    const allClosures = (await entriesAround('2019-01-01', `${year + 3}-12-31`)).filter((e) => e.kind === 'closure');
    for (const person of await db.listPeople()) {
      const from = person.snapshot?.asOf || rules.leaveAnchor(person, settings);
      if (cutoff <= from) continue;
      const own = (await db.listUserEntries(person.userId, from, `${year + 3}-12-31`)).filter((e) => e.kind !== 'closure');
      const snapshot = rules.snapshotAt({ person, cutoff, entries: own, closures: allClosures, settings });
      await db.putPerson({ ...person, snapshot }, {
        id: randomUUID(), at: now().toISOString(), actorId: 'system', action: 'snapshot', subjectUserId: person.userId,
      });
    }
    let deletedEntries = 0;
    const seen = new Set();
    for (let y = 2019; y <= year - 3; y++) {
      for (const e of await db.listYearEntries(y)) {
        if (e.end >= cutoff || seen.has(e.id)) continue;
        seen.add(e.id);
        await db.deleteEntry(e.id, e.rev, auditRecord(system, 'retention', e));
        deletedEntries += 1;
      }
    }
    const deletedAudit = await db.purgeAudit(`${cutoff}T00:00:00.000Z`);
    console.log('Retention done', { cutoff, deletedEntries, deletedAudit });
    return { cutoff, deletedEntries, deletedAudit };
  }

  async function updateMe(req) {
    const me = await caller(req);
    const { value, error } = rules.validateName(readBody(req).name);
    if (error) throw new HttpError(400, error);
    const person = { ...me.person, name: value, updatedAt: now().toISOString() };
    await db.putPerson(person);
    return { item: { name: person.name } };
  }

  return { handle, runRetention };
}

function strip(body) {
  if (body && typeof body === 'object' && 'created' in body) {
    const { created, ...rest } = body;
    return rest;
  }
  return body;
}

// Reads the children's calendar. Calendar servers answer within a few seconds.
async function defaultFetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error('too large');
  return text;
}
