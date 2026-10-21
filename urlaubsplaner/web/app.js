// NW7: "Übersicht" (month table, start page), "Kalender" (one person's year with the leave
// account), "Anträge" and "Einstellungen", plus the entry drawer.
// The browser never counts days; numbers come from the API (/api/overview, /api/check).
import { devSignIn, devUsers, initAuth, isSignedIn, signIn, signOut } from './auth.js';
import {
  HALF, MONTHS, STATUS, WD_KEYS, WEEKDAYS, addDays, api, days, download, h, isoOf,
  kindText as kindLabel, longDate, num, onSignedOut, rangeText, showToast, weekdayIndex,
} from './ui.js';
import { requestsPage } from './requests.js';
import { settingsPage } from './settings.js';
import { teamPage } from './team.js';

const main = document.getElementById('main');
const topActions = document.getElementById('top-actions');
const drawer = document.getElementById('drawer');
const nameDialog = document.getElementById('name-dialog');
const extraDialog = document.getElementById('extra-dialog');

// subject: whose calendar is shown (empty = your own).
const state = { year: null, view: 'year', month: 0, data: null, drag: null, suppressClick: false, subject: '' };

const kindText = (e) => kindLabel(e, state.data.reasons);

// ---------- start ----------

async function start() {
  onSignedOut(showSignedOut);
  window.addEventListener('hashchange', () => { if (state.data) render(); });
  try {
    await initAuth();
  } catch {
    main.replaceChildren(h('p', { class: 'error' }, 'Die Seite konnte nicht geladen werden. Bitte versuche es später noch einmal.'));
    return;
  }
  if (!isSignedIn()) {
    showSignedOut();
    return;
  }
  await load();
}

function showSignedOut() {
  topActions.replaceChildren();
  const users = devUsers();
  const card = h('section', { class: 'card welcome' },
    h('h1', {}, 'NW7 Urlaubsplaner'),
    h('p', {}, 'Urlaub von Familie und Personal, Ferien der Kinder und Sperrzeiten auf einen Blick.'));
  if (users) {
    card.append(
      h('p', { class: 'hint' }, 'Lokale Testversion: Wähle, als wer du dich anmeldest.'),
      h('div', { class: 'dev-users' }, users.map((u) => h('button', {
        class: 'button',
        type: 'button',
        onclick: () => { devSignIn(u.id); load(); },
      }, `${u.name} (${u.label})`))),
    );
  } else {
    card.append(h('button', { class: 'button primary', type: 'button', onclick: signIn }, 'Anmelden'));
  }
  main.replaceChildren(card);
}

async function load(year = state.year) {
  try {
    const q = new URLSearchParams();
    if (year) q.set('year', year);
    if (state.subject) q.set('userId', state.subject);
    const data = await api('GET', `/api/overview${q.size ? `?${q}` : ''}`);
    if (!data) return;
    const first = !state.data;
    state.data = data;
    state.year = data.year;
    if (first) state.month = Number(data.today.slice(5, 7)) - 1;
    // Those who plan start with the first household person instead of themselves.
    if (first && !state.subject && data.me.canPlan && data.subject.role !== 'household') {
      const staff = data.people.find((p) => p.role === 'household');
      if (staff) {
        state.subject = staff.userId;
        await load(year);
        return;
      }
    }
    render();
  } catch (err) {
    if (err.status === 401) return;
    main.replaceChildren(h('section', { class: 'card' },
      h('p', { class: 'error', role: 'alert' }, err.message),
      h('button', { class: 'button', type: 'button', onclick: () => load() }, 'Nochmal versuchen')));
  }
}

// ---------- page ----------

function currentPage() {
  const page = location.hash.slice(1);
  if (page === 'kalender') return page;
  if ((page === 'antraege' || page === 'einstellungen') && state.data.me.canPlan) return page;
  return 'uebersicht';
}

function renderNav(page) {
  const d = state.data;
  const link = (href, id, ...label) => h('a', { href, class: 'tab', 'aria-current': page === id ? 'page' : null }, ...label);
  return h('nav', { class: 'tabs', 'aria-label': 'Bereiche' },
    link('#', 'uebersicht', 'Übersicht'),
    link('#kalender', 'kalender', 'Kalender'),
    d.me.canPlan ? link('#antraege', 'antraege', 'Anträge',
      d.openRequests ? h('span', { class: 'count', 'aria-label': `${d.openRequests} offen` }, String(d.openRequests)) : null) : null,
    d.me.canPlan ? link('#einstellungen', 'einstellungen', 'Einstellungen') : null);
}

function openCalendarOf(userId) {
  state.subject = userId;
  location.hash = 'kalender';
  load();
}

function render() {
  const d = state.data;
  topActions.replaceChildren(
    h('button', { class: 'link', type: 'button', onclick: openNameDialog }, d.me.name),
    h('button', { class: 'button small', type: 'button', onclick: signOut }, 'Abmelden'),
  );
  const page = currentPage();
  if (page === 'uebersicht') {
    main.replaceChildren(renderNav(page), teamPage({
      today: d.today, myId: d.me.userId, canPlan: d.me.canPlan, onPick: pickFromTeam, onOpen: openCalendarOf,
    }));
    return;
  }
  if (page === 'antraege') {
    main.replaceChildren(renderNav(page), requestsPage({ onDecided: () => load() }));
    return;
  }
  if (page === 'einstellungen') {
    main.replaceChildren(renderNav(page), settingsPage({
      today: d.today, myId: d.me.userId, canApprove: d.me.canApprove, onChanged: () => load(),
    }));
    return;
  }

  const focusDate = document.activeElement?.dataset?.date;
  const s = d.subject;
  const own = s.userId === d.me.userId;
  main.replaceChildren(...[
    renderNav(page),
    h('section', { class: 'intro' },
      d.people.length ? renderPicker() : null,
      h('h1', {}, own ? `Hallo ${d.me.name}` : s.name),
      h('p', { class: 'hint' }, `${s.job || s.roleLabel}${s.role === 'household' ? ' · Arbeitstage: ' : ''}`,
        s.role === 'household' ? s.workPattern.map((k) => WEEKDAYS[WD_KEYS.indexOf(k)].slice(0, 2)).join(', ') : '',
        s.sperrzeiten ? ' · Sperrzeiten gelten' : '')),
    s.hasAccount ? renderBalance(d.balance, s.rest) : null,
    renderToolbar(),
    renderLegend(),
    renderCalendar(),
    renderEntries(),
    renderExport(),
  ].filter(Boolean));
  if (focusDate) main.querySelector(`[data-date="${focusDate}"]`)?.focus();
}

// Approvers: a click on a day in someone's row of the team view opens the drawer for them.
async function pickFromTeam({ userId, date, entryId }) {
  if (!entryId) {
    openDrawer(null, date, date, userId);
    return;
  }
  try {
    openDrawer(await api('GET', `/api/entries/${entryId}`));
  } catch (err) {
    showToast(err.message);
  }
}

// Those who plan switch between people here.
function renderPicker() {
  const d = state.data;
  const select = h('select', { id: 'pick-person', 'aria-label': 'Kalender von' },
    d.people.map((p) => h('option', { value: p.userId, selected: p.userId === d.subject.userId },
      `${p.name}${p.job ? ` (${p.job})` : p.role === 'family' ? ' (Familie)' : ''}`)));
  select.addEventListener('change', () => openCalendarOf(select.value));
  return h('div', { class: 'person-pick' }, h('label', { for: 'pick-person', class: 'hint' }, 'Kalender von'), select);
}

function carryText(b) {
  if (b.carryOver > 0) return `${num(b.allowance)} + ${num(b.carryOver)} Rest aus Vorjahren`;
  if (b.carryOver < 0) return `${num(b.allowance)}, davon ${num(-b.carryOver)} schon in Vorjahren genommen`;
  return 'in diesem Urlaubsjahr';
}

// The account for the current leave year (from the start date, e.g. 2 May to 1 May).
function renderBalance(b, rest) {
  const box = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}` },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'stat-value' }, num(value)),
    sub ? h('span', { class: 'stat-sub' }, sub) : null);
  const short = (iso) => iso.split('-').reverse().join('.');
  const range = `${short(b.yearStart)}–${short(b.yearEnd)}`;
  const section = h('section', { class: 'balance-wrap', 'aria-label': `Urlaubskonto, Urlaubsjahr ${range}` },
    h('p', { class: 'hint' }, `Urlaubsjahr ${range}`),
    h('div', { class: 'balance' },
      box('Anspruch', b.total, rest ? `Stand ${short(rest.asOf)}: ${num(rest.days)} Rest${b.carryOver > 0 ? `, + neues Urlaubsjahr` : ''}` : carryText(b)),
      box('Genommen', b.taken, 'in diesem Urlaubsjahr'),
      box('Geplant', b.planned, 'ab heute, bestätigt'),
      box('Beantragt', b.pending, 'wartet auf Bestätigung', b.pending ? 'is-pending' : ''),
      box('Übrig', b.remaining, b.pending ? `${num(b.remaining - b.pending)} wenn alles bestätigt wird` : 'Tage', 'is-main')));
  if (b.expiring) {
    section.append(h('p', { class: 'notice' },
      `${days(b.expiring.days)} aus früheren Urlaubsjahren ${b.expiring.days === 1 ? 'verfällt' : 'verfallen'} am ${longDate(b.expiring.date)}, wenn sie bis dahin nicht genommen ${b.expiring.days === 1 ? 'wird' : 'werden'}.`));
  }
  return section;
}

function renderToolbar() {
  const y = state.year;
  const isYear = state.view === 'year';
  const step = (delta) => () => {
    if (isYear) {
      load(y + delta);
      return;
    }
    const m = state.month + delta;
    if (m < 0 || m > 11) {
      state.month = (m + 12) % 12;
      load(y + Math.sign(delta));
    } else {
      state.month = m;
      render();
    }
  };
  const label = isYear ? String(y) : `${MONTHS[state.month]} ${y}`;
  const switchView = (view) => () => {
    state.view = view;
    render();
  };
  return h('section', { class: 'toolbar' },
    h('div', { class: 'pager' },
      h('button', { class: 'button icon', type: 'button', 'aria-label': isYear ? 'Jahr davor' : 'Monat davor', onclick: step(-1), disabled: isYear ? y <= 2020 : (y <= 2020 && state.month === 0) }, '‹'),
      h('h2', { class: 'pager-label', 'aria-live': 'polite' }, label),
      h('button', { class: 'button icon', type: 'button', 'aria-label': isYear ? 'Nächstes Jahr' : 'Nächster Monat', onclick: step(1), disabled: isYear ? y >= 2040 : (y >= 2040 && state.month === 11) }, '›')),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Ansicht' },
      h('button', { type: 'button', 'aria-pressed': String(isYear), onclick: switchView('year') }, 'Jahr'),
      h('button', { type: 'button', 'aria-pressed': String(!isYear), onclick: switchView('month') }, 'Monat')),
    h('button', { class: 'button primary', type: 'button', onclick: () => openDrawer(null, defaultNewDate()) }, '+ Neuer Eintrag'));
}

function defaultNewDate() {
  const today = state.data.today;
  if (today.startsWith(String(state.year)) && (state.view === 'year' || Number(today.slice(5, 7)) - 1 === state.month)) return today;
  return isoOf(state.year, state.view === 'year' ? 0 : state.month, 1);
}

function renderLegend() {
  const item = (cls, text) => h('li', {}, h('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' }), text);
  return h('ul', { class: 'legend', 'aria-label': 'Legende' },
    item('k-vacation', 'Urlaub'),
    item('k-vacation half-am', 'Halber Tag'),
    item('k-absence', 'Andere Abwesenheit'),
    item('k-vacation pending', 'Beantragt'),
    item('ferien', 'Ferien der Kinder'),
    state.data.subject.sperrzeiten ? item('blocked', 'Sperrzeit') : null,
    item('holiday', 'Feiertag'),
    item('closure', 'Alle frei'),
    item('free', 'Kein Arbeitstag'),
    item('today', 'Heute'));
}

// ---------- calendar ----------

function dayIndex() {
  const d = state.data;
  const holidays = new Map(d.holidays.map((x) => [x.date, x.name]));
  const closures = new Map();
  for (const c of d.closures) for (let x = c.start; x <= c.end; x = addDays(x, 1)) closures.set(x, c);
  const ferien = new Map();
  for (const f of d.ferien) for (let x = f.start; x <= f.end; x = addDays(x, 1)) if (!ferien.has(x)) ferien.set(x, f);
  const blocked = new Map(d.blocked.map((b) => [b.date, b]));
  const entries = new Map();
  for (const e of d.entries) {
    if (e.status === 'declined') continue;
    for (let x = e.start; x <= e.end; x = addDays(x, 1)) {
      if (!entries.has(x)) entries.set(x, []);
      entries.get(x).push(e);
    }
  }
  return { holidays, closures, entries, ferien, blocked };
}

function dayCell(iso, idx, { big }) {
  const d = state.data;
  const wd = WD_KEYS[weekdayIndex(iso)];
  const works = d.subject.workPattern.includes(wd) && d.practice.openDays.includes(wd);
  const holiday = idx.holidays.get(iso);
  const closure = idx.closures.get(iso);
  const list = idx.entries.get(iso) || [];
  const e = list[0];
  const both = list.length > 1 && list.every((x) => x.half);
  const cls = ['day'];
  const said = [];
  if (!works) { cls.push('free'); said.push('kein Arbeitstag'); }
  if (holiday) { cls.push('holiday'); said.push(`Feiertag: ${holiday}`); }
  if (closure) { cls.push('closure'); said.push(`Alle frei${closure.label ? `: ${closure.label}` : ''}`); }
  const ferien = idx.ferien.get(iso);
  if (ferien) { cls.push('ferien'); said.push(`Ferien: ${ferien.label}`); }
  const block = works && !holiday ? idx.blocked.get(iso) : null;
  if (block) { cls.push('blocked', block.soft ? 'soft' : ''); said.push(block.soft ? `${block.why}: nur nach Absprache` : `Sperrzeit: ${block.why}`); }
  if (e) {
    cls.push('has-entry', `k-${e.kind}`);
    if (e.status === 'pending') cls.push('pending');
    if (e.half && !both) cls.push(`half-${e.half}`);
    for (const x of list) said.push(`${kindText(x)}${x.half && !kindText(x).includes('halber') ? `, ${HALF[x.half]}` : ''} (${STATUS[x.status]})`);
  }
  if (iso === d.today) { cls.push('today'); said.push('heute'); }

  const label = `${WEEKDAYS[weekdayIndex(iso)]}, ${longDate(iso)}${said.length ? ` – ${said.join(', ')}` : ''}`;
  const short = big ? (holiday || (e ? kindText(e) : closure ? (closure.label || 'Alle frei') : ferien ? ferien.label : '')) : '';
  return h('button', {
    type: 'button',
    class: cls.filter(Boolean).join(' '),
    dataset: { date: iso },
    'aria-label': label,
    title: label,
    tabindex: '-1',
  },
  h('span', { class: 'num' }, String(Number(iso.slice(8)))),
  short ? h('span', { class: 'tag' }, short) : null);
}

function monthGrid(y, m, idx, { big }) {
  const first = isoOf(y, m, 1);
  const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < weekdayIndex(first); i++) cells.push(h('span', { class: 'blank', 'aria-hidden': 'true' }));
  for (let day = 1; day <= length; day++) cells.push(dayCell(isoOf(y, m, day), idx, { big }));
  return h('div', { class: `month ${big ? 'big' : ''}` },
    h('h3', { class: 'month-title' }, big ? `${MONTHS[m]} ${y}` : MONTHS[m]),
    h('div', { class: 'weekdays', 'aria-hidden': 'true' }, WEEKDAYS.map((w) => h('span', {}, w.slice(0, 2)))),
    h('div', { class: 'days' }, cells));
}

function renderCalendar() {
  const idx = dayIndex();
  const y = state.year;
  const big = state.view === 'month';
  const months = big ? [state.month] : [...Array(12).keys()];
  const cal = h('section', {
    class: `calendar ${big ? 'is-month' : 'is-year'}`,
    'aria-label': 'Kalender. Mit den Pfeiltasten wählst du einen Tag, mit Enter öffnest du ihn.',
    onclick: onDayClick,
    onkeydown: onCalendarKey,
    onpointerdown: onPointerDown,
    onpointerover: onPointerOver,
  }, months.map((m) => monthGrid(y, m, idx, { big })));

  // One day is reachable with Tab; the arrow keys move from there.
  const today = state.data.today;
  const target = cal.querySelector(`[data-date="${today}"]`) || cal.querySelector('[data-date]');
  if (target) target.tabIndex = 0;
  return cal;
}

function onDayClick(ev) {
  const btn = ev.target.closest('[data-date]');
  if (!btn) return;
  if (state.suppressClick) {
    state.suppressClick = false;
    return;
  }
  const iso = btn.dataset.date;
  const e = (dayIndex().entries.get(iso) || [])[0];
  if (e) openDrawer(e);
  else openDrawer(null, iso);
}

function onCalendarKey(ev) {
  const btn = ev.target.closest('[data-date]');
  if (!btn) return;
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (!(ev.key in moves)) return;
  const next = ev.currentTarget.querySelector(`[data-date="${addDays(btn.dataset.date, moves[ev.key])}"]`);
  if (!next) return;
  ev.preventDefault();
  btn.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

// Drag across days with the mouse to book a range. Touch keeps normal scrolling.
function onPointerDown(ev) {
  const btn = ev.target.closest('[data-date]');
  if (!btn || ev.pointerType !== 'mouse' || ev.button !== 0) return;
  state.drag = { anchor: btn.dataset.date, current: btn.dataset.date };
  document.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerOver(ev) {
  if (!state.drag) return;
  const btn = ev.target.closest('[data-date]');
  if (!btn || btn.dataset.date === state.drag.current) return;
  state.drag.current = btn.dataset.date;
  const [a, b] = [state.drag.anchor, state.drag.current].sort();
  for (const el of main.querySelectorAll('[data-date]')) {
    el.classList.toggle('selecting', el.dataset.date >= a && el.dataset.date <= b);
  }
}

function onPointerUp() {
  const drag = state.drag;
  state.drag = null;
  for (const el of main.querySelectorAll('.selecting')) el.classList.remove('selecting');
  if (!drag || drag.anchor === drag.current) return;
  state.suppressClick = true;
  setTimeout(() => { state.suppressClick = false; }, 0);
  const [a, b] = [drag.anchor, drag.current].sort();
  openDrawer(null, a, b);
}

// ---------- own entries ----------

function renderEntries() {
  const list = state.data.entries;
  const s = state.data.subject;
  const section = h('section', { class: 'card entries' }, h('h2', {}, `${s.userId === state.data.me.userId ? 'Meine Einträge' : `Einträge von ${s.name}`} ${state.year}`));
  if (!list.length) {
    section.append(h('p', { class: 'hint' }, 'Noch nichts eingetragen. Klick auf einen Tag im Kalender oder auf „Neuer Eintrag“.'));
    return section;
  }
  section.append(h('ul', { class: 'entry-list' }, list.map((e) => h('li', {},
    h('button', { type: 'button', class: `entry k-${e.kind} ${e.status}`, onclick: () => openDrawer(e) },
      h('span', { class: 'entry-dates' }, rangeText(e)),
      h('span', { class: 'entry-kind' }, kindText(e), e.kind === 'vacation' ? ` · ${days(e.days)}` : ''),
      e.note ? h('span', { class: 'entry-note' }, e.note) : null,
      e.substitute ? h('span', { class: 'entry-note' }, `Vertretung: ${e.substitute}`) : null,
      e.decisionComment ? h('span', { class: 'entry-note' }, `Kommentar: ${e.decisionComment}`) : null,
      h('span', { class: `badge ${e.status}` }, STATUS[e.status]))))));
  return section;
}

// ---------- drawer ----------

// forUserId: entering leave for someone else (from the overview or the open calendar).
function openDrawer(entry, start, end = start, forUserId = null) {
  const d = state.data;
  const isNew = !entry;
  const people = d.people || [];
  const personOf = (id) => people.find((p) => p.userId === id) || (id === d.me.userId ? d.me : null);
  const e = entry || { kind: 'vacation', reason: '', start, end, half: '', note: '' };
  const locked = !isNew && !d.me.canPlan && e.status === 'approved' && e.start < d.today;
  let checkSeq = 0;

  const radio = (name, value, text, checked) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name, value, checked }), h('span', {}, text));

  const form = h('form', { method: 'dialog', class: 'drawer-form', novalidate: true });
  const reasonSelect = h('select', { name: 'reason', id: 'f-reason' },
    h('option', { value: '' }, 'Bitte wählen'),
    Object.entries(d.reasons).map(([k, v]) => h('option', { value: k, selected: e.reason === k }, v)));
  const startInput = h('input', { type: 'date', name: 'start', id: 'f-start', value: e.start, min: '2020-01-01', max: '2040-12-31', required: true });
  const endInput = h('input', { type: 'date', name: 'end', id: 'f-end', value: e.end, min: '2020-01-01', max: '2040-12-31', required: true });
  const note = h('textarea', { name: 'note', id: 'f-note', maxlength: '300', rows: '3' });
  const canPick = isNew && d.me.canPlan && people.length > 0;
  const target = forUserId || d.subject.userId;
  const who = canPick ? h('select', { id: 'f-who' },
    people.map((p) => h('option', { value: p.userId, selected: p.userId === target },
      `${p.name}${p.userId === d.me.userId ? ' (ich)' : p.job ? ` (${p.job})` : ''}`))) : null;
  // Only the parents can mark something as already agreed.
  const agreed = canPick && d.me.canApprove ? h('input', { type: 'checkbox', id: 'f-agreed' }) : null;
  const ownerId = () => (who ? who.value : (entry ? entry.userId : d.me.userId));
  const isStaff = () => (personOf(ownerId())?.role || d.me.role) === 'household';
  const isFamily = () => (personOf(ownerId())?.role || d.me.role) === 'family';
  const substitute = h('input', { id: 'f-substitute', name: 'substitute', maxlength: '300', value: e.substitute || '', autocomplete: 'off' });
  note.value = e.note || '';
  const counter = h('span', { class: 'counter' });
  const summary = h('p', { class: 'summary', 'aria-live': 'polite' });
  const warning = h('p', { class: 'notice warning', 'aria-live': 'polite' });
  const error = h('p', { class: 'error', role: 'alert' });
  const halfField = h('fieldset', { class: 'choices' }, h('legend', {}, 'Dauer'),
    radio('half', '', 'Ganzer Tag', !e.half),
    radio('half', 'am', 'Vormittag', e.half === 'am'),
    radio('half', 'pm', 'Nachmittag', e.half === 'pm'));
  const reasonField = h('div', { class: 'field' }, h('label', { for: 'f-reason' }, 'Grund'), reasonSelect);
  const substituteField = h('div', { class: 'field' },
    h('label', { for: 'f-substitute' }, 'Vertretung ', h('span', { class: 'hint' }, '(freiwillig, z. B. Name und Telefon)')),
    substitute);
  const agreedField = agreed ? h('label', { class: 'check', for: 'f-agreed' }, agreed,
    h('span', {}, 'Ist schon genehmigt', h('span', { class: 'hint' }, ' (wird gleich bestätigt, kein Antrag nötig)'))) : null;
  const whoField = canPick ? h('div', { class: 'who' },
    h('div', { class: 'field' }, h('label', { for: 'f-who' }, 'Für wen'), who), agreedField) : null;
  const saveBtn = h('button', { class: 'button primary', type: 'submit' }, isNew ? 'Eintragen' : 'Speichern');

  form.append(...[
    h('header', { class: 'drawer-head' },
      h('h2', { id: 'drawer-title' }, isNew ? 'Neuer Eintrag'
        : entry.userId !== d.me.userId ? `Eintrag von ${personOf(entry.userId)?.name || 'jemand anderem'}` : 'Eintrag'),
      isNew ? null : h('span', { class: `badge ${e.status}` }, STATUS[e.status]),
      h('button', { class: 'button icon close', type: 'button', 'aria-label': 'Schließen', onclick: () => drawer.close() }, '×')),
    locked ? h('p', { class: 'notice' }, 'Dieser Urlaub hat schon begonnen. Änderungen macht die Organisation.') : null,
    whoField,
    h('fieldset', { class: 'choices' }, h('legend', {}, 'Art'),
      radio('kind', 'vacation', 'Urlaub', e.kind === 'vacation'),
      radio('kind', 'absence', 'Andere Abwesenheit', e.kind === 'absence')),
    reasonField,
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: 'f-start' }, 'Von'), startInput),
      h('div', { class: 'field' }, h('label', { for: 'f-end' }, 'Bis'), endInput)),
    halfField,
    substituteField,
    h('div', { class: 'field' },
      h('label', { for: 'f-note' }, 'Notiz ', h('span', { class: 'hint' }, '(sehen nur Eltern und Organisation, nicht in der Übersicht)')),
      note, counter),
    summary,
    warning,
    !isNew && e.decisionComment ? h('p', { class: 'hint' }, `Kommentar: ${e.decisionComment}`) : null,
    error,
    h('div', { class: 'actions' },
      locked ? null : saveBtn,
      !isNew && !locked ? h('button', { class: 'button danger', type: 'button', onclick: remove }, 'Löschen') : null,
      h('button', { class: 'button', type: 'button', onclick: () => drawer.close() }, locked ? 'Schließen' : 'Abbrechen')),
  ].filter(Boolean));
  if (locked) for (const el of form.querySelectorAll('input, select, textarea')) el.disabled = true;

  function values() {
    const fd = new FormData(form);
    const kind = fd.get('kind');
    const s = startInput.value;
    let en = endInput.value || s;
    const half = s === en ? (fd.get('half') || '') : '';
    return {
      kind, reason: kind === 'absence' ? reasonSelect.value : '', start: s, end: en, half, note: note.value,
      substitute: isStaff() ? substitute.value : '',
      ...(canPick ? { userId: who.value, approved: !!agreed?.checked } : {}),
    };
  }

  function sync() {
    const v = values();
    reasonField.hidden = v.kind !== 'absence';
    const oneDay = v.start && v.start === v.end;
    for (const input of halfField.querySelectorAll('input[value="am"], input[value="pm"]')) input.disabled = locked || !oneDay;
    if (!oneDay) halfField.querySelector('input[value=""]').checked = true;
    counter.textContent = `${note.value.length} / 300`;
    substituteField.hidden = !isStaff();
    if (agreedField) agreedField.hidden = isFamily();
  }

  async function check() {
    if (locked) return;
    const seq = ++checkSeq;
    const v = values();
    if (!v.start) {
      summary.textContent = '';
      return;
    }
    try {
      const res = await api('POST', '/api/check', { ...v, id: entry?.id });
      if (seq !== checkSeq || !res) return;
      summary.classList.toggle('warn', !res.ok);
      summary.textContent = res.ok ? summaryText(v, res) : res.error;
      warning.textContent = res.ok && res.warningText
        ? `Achtung: ${res.warningText} Eintragen geht trotzdem, die Eltern sehen den Hinweis.`
        : '';
    } catch {
      // the live summary is optional; saving shows any real error
    }
  }

  async function save(ev) {
    ev.preventDefault();
    if (locked) return;
    error.textContent = '';
    saveBtn.disabled = true;
    try {
      const v = values();
      if (isNew) await api('POST', '/api/entries', v);
      else await api('PUT', `/api/entries/${entry.id}`, { ...v, expectedRev: entry.rev });
      drawer.close();
      showToast(savedText(v, isNew));
      await load();
    } catch (err) {
      error.textContent = err.message;
      if (err.status === 409) error.append(' ', h('button', { class: 'link', type: 'button', onclick: () => { drawer.close(); load(); } }, 'Neu laden'));
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function remove() {
    if (!window.confirm(`Eintrag ${rangeText(entry)} wirklich löschen?`)) return;
    try {
      await api('DELETE', `/api/entries/${entry.id}?rev=${entry.rev}`);
      drawer.close();
      showToast('Gelöscht.');
      await load();
    } catch (err) {
      error.textContent = err.message;
    }
  }

  let timer;
  form.addEventListener('input', () => {
    if (startInput.value && endInput.value && endInput.value < startInput.value && document.activeElement === startInput) {
      endInput.value = startInput.value;
    }
    sync();
    clearTimeout(timer);
    timer = setTimeout(check, 250);
  });
  form.addEventListener('submit', save);

  drawer.replaceChildren(form);
  sync();
  check();
  drawer.showModal();
  (locked ? form.querySelector('.close') : form.querySelector('input[name="kind"]:checked'))?.focus();
}

// ---------- export and calendar subscription ----------

function renderExport() {
  const y = state.year;
  const run = (path, name) => async () => {
    try {
      await download(path, name);
    } catch (err) {
      showToast(err.message);
    }
  };
  return h('section', { class: 'card export' },
    h('h2', {}, 'Mitnehmen'),
    h('p', { class: 'hint' }, `Deine eigenen Einträge ${y} als Datei, oder den Urlaub aller automatisch in deinem Handy-Kalender (Kalender-Abo).`),
    h('div', { class: 'actions' },
      h('button', { class: 'button', type: 'button', onclick: run(`/api/export.ics?year=${y}`, `abwesenheiten-${y}.ics`) }, 'Kalenderdatei (.ics)'),
      h('button', { class: 'button', type: 'button', onclick: run(`/api/export.csv?year=${y}`, `abwesenheiten-${y}.csv`) }, 'Tabelle für Excel (.csv)'),
      h('button', { class: 'button', type: 'button', onclick: openFeedDialog }, 'Kalender-Abo')));
}

function openFeedDialog() {
  const box = h('div', { class: 'feed' });
  const error = h('p', { class: 'error', role: 'alert' });
  const draw = () => {
    const url = state.data.me.feedUrl;
    const input = url ? h('input', { id: 'feed-url', value: url, readonly: true }) : null;
    box.replaceChildren(...[
      h('p', {}, 'Mit diesem Link zeigt dein Handy- oder Outlook-Kalender den bestätigten Urlaub aller an, ohne Notizen. Er aktualisiert sich von selbst.'),
      h('p', { class: 'notice' }, 'Der Link ist wie ein Schlüssel: Wer ihn hat, sieht die Abwesenheiten. Gib ihn nicht weiter.'),
      url ? h('div', { class: 'field' }, h('label', { for: 'feed-url' }, 'Dein Link'), input) : null,
      url ? h('ul', { class: 'hint steps' },
        h('li', {}, 'iPhone: Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo hinzufügen'),
        h('li', {}, 'Google Kalender (am Computer): Weitere Kalender → + → Per URL'),
        h('li', {}, 'Outlook: Kalender hinzufügen → Aus dem Internet abonnieren')) : null,
      error,
      h('div', { class: 'actions' },
        url ? h('button', {
          class: 'button primary',
          type: 'button',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(url);
              showToast('Link kopiert.');
            } catch {
              input.select();
            }
          },
        }, 'Link kopieren') : null,
        h('button', { class: url ? 'button' : 'button primary', type: 'button', onclick: () => change('PUT') }, url ? 'Neuen Link erstellen' : 'Link erstellen'),
        url ? h('button', { class: 'button danger', type: 'button', onclick: () => change('DELETE') }, 'Link löschen') : null,
        h('button', { class: 'button', type: 'button', onclick: () => extraDialog.close() }, 'Schließen')),
    ].filter(Boolean));
  };
  async function change(method) {
    error.textContent = '';
    if (method === 'DELETE' || state.data.me.feedUrl) {
      const question = method === 'DELETE'
        ? 'Link löschen? Kalender, die ihn verwenden, zeigen dann nichts mehr an.'
        : 'Neuen Link erstellen? Der alte Link funktioniert dann sofort nicht mehr.';
      if (!window.confirm(question)) return;
    }
    try {
      const res = await api(method, '/api/me/feed');
      state.data.me.feedUrl = method === 'PUT' ? res.url : '';
      draw();
    } catch (err) {
      error.textContent = err.message;
    }
  }
  draw();
  extraDialog.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'extra-title' }, 'Kalender-Abo'), box));
  extraDialog.showModal();
}

function savedText(v, isNew) {
  if (!isNew) return 'Gespeichert.';
  const d = state.data;
  const other = v.userId && v.userId !== d.me.userId ? (d.people || []).find((p) => p.userId === v.userId) : null;
  if (other?.role === 'family') return `Familienurlaub von ${other.name} eingetragen.`;
  if (other) return v.approved ? `Für ${other.name} eingetragen und bestätigt.` : `Für ${other.name} eingetragen, wartet auf Bestätigung.`;
  if (v.approved || d.me.role === 'family') return 'Eingetragen.';
  return v.kind === 'vacation' ? 'Eingetragen. Die Eltern bestätigen den Antrag.' : 'Gespeichert.';
}

// "dir" for your own entries, the person's name when an approver enters for someone else.
function whom(v) {
  const d = state.data;
  if (!v.userId || v.userId === d.me.userId) return 'dir';
  return (d.people || []).find((p) => p.userId === v.userId)?.name || 'der Person';
}

function summaryText(v, res) {
  const d = state.data;
  const person = (d.people || []).find((p) => p.userId === (v.userId || d.me.userId)) || d.me;
  if (person.role === 'family') return 'Familienurlaub: wird gleich eingetragen, ohne Antrag. Die Woche davor und danach wird zur Sperrzeit.';
  if (v.kind !== 'vacation') return 'Zählt nicht als Urlaub.';
  const what = `${num(res.days)} ${res.days === 1 ? 'Urlaubstag' : 'Urlaubstage'}`;
  return `${what}. Danach bleiben ${whom(v)} ${days(res.remainingAfter)}.`;
}

// ---------- display name ----------

function openNameDialog() {
  const input = h('input', { id: 'f-name', name: 'name', maxlength: '80', value: state.data.me.name, autocomplete: 'off' });
  const error = h('p', { class: 'error', role: 'alert' });
  const form = h('form', {
    method: 'dialog',
    onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        await api('PUT', '/api/me', { name: input.value });
        nameDialog.close();
        showToast('Name gespeichert.');
        await load();
      } catch (err) {
        error.textContent = err.message;
      }
    },
  },
  h('h2', { id: 'name-title' }, 'Dein Name im Planer'),
  h('p', { class: 'hint' }, 'So sehen dich die anderen im Planer.'),
  h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Name'), input),
  error,
  h('div', { class: 'actions' },
    h('button', { class: 'button primary', type: 'submit' }, 'Speichern'),
    h('button', { class: 'button', type: 'button', onclick: () => nameDialog.close() }, 'Abbrechen')));
  nameDialog.replaceChildren(form);
  nameDialog.showModal();
  input.select();
}

start();
