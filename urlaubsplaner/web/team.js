// "Übersicht": one month as a table, like the household's old spreadsheet. Rows for the
// family's holiday, the children's school and kindergarten holidays, and the household
// staff. Sperrzeiten are hatched in red. Shows names, dates, type and status; never notes.
import {
  HALF, MONTHS, STATUS, WD_KEYS, WEEKDAYS, addDays, api, days, h, kindText, longDate, num, weekdayIndex,
} from './ui.js';

const view = { month: null };

// canPlan + onPick: a click on a day in someone's row enters or opens their leave.
// onOpen(userId): opens that person's calendar (leave accounts on top).
export function teamPage({ today, myId, canPlan = false, onPick = null, onOpen = null }) {
  if (!view.month) view.month = today.slice(0, 7);
  const section = h('section', { class: 'team' }, h('p', { class: 'loading' }, 'Wird geladen …'));
  view.pick = canPlan && onPick ? onPick : null;
  view.open = onOpen;
  load(section, today, myId);
  return section;
}

function pickCell(ev) {
  if (!view.pick) return;
  if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
  const cell = ev.target.closest('td[data-user]');
  if (!cell) return;
  ev.preventDefault();
  view.pick({ userId: cell.dataset.user, date: cell.dataset.date, entryId: cell.dataset.entry || '' });
}

async function load(section, today, myId) {
  try {
    const data = await api('GET', `/api/team?month=${view.month}`);
    if (data) draw(data);
  } catch (err) {
    if (err.status === 401) return;
    section.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));
  }

  function draw(data) {
    const [y, m] = view.month.split('-').map(Number);
    const step = (delta) => () => {
      const d = new Date(Date.UTC(y, m - 1 + delta, 1));
      view.month = d.toISOString().slice(0, 7);
      load(section, today, myId);
    };
    section.replaceChildren(...[
      accounts(data),
      h('div', { class: 'toolbar' },
        h('div', { class: 'pager' },
          h('button', { class: 'button icon', type: 'button', 'aria-label': 'Monat davor', onclick: step(-1), disabled: view.month <= '2020-01' }, '‹'),
          h('h1', { class: 'pager-label', 'aria-live': 'polite' }, `${MONTHS[m - 1]} ${y}`),
          h('button', { class: 'button icon', type: 'button', 'aria-label': 'Nächster Monat', onclick: step(1), disabled: view.month >= '2040-12' }, '›')),
        view.month !== today.slice(0, 7) ? h('button', {
          class: 'button small', type: 'button', onclick: () => { view.month = today.slice(0, 7); load(section, today, myId); },
        }, 'Heute') : null),
      awayStrip(data),
      view.pick ? h('p', { class: 'hint' }, 'Klick auf einen Tag in der Zeile einer Person, um für sie einzutragen. Ein farbiger Tag öffnet den Eintrag.') : null,
      timeline(data, myId),
      h('ul', { class: 'legend', 'aria-label': 'Legende' },
        legendItem('k-vacation', 'Urlaub'),
        legendItem('k-vacation pending', 'Beantragt'),
        legendItem('k-absence', 'Andere Abwesenheit'),
        legendItem('ferien', 'Ferien'),
        legendItem('blocked', 'Sperrzeit'),
        legendItem('holiday', 'Feiertag'),
        legendItem('free', 'Kein Arbeitstag')),
    ].filter(Boolean));
  }
}

function legendItem(cls, text) {
  return h('li', {}, h('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' }), text);
}

// Leave accounts of the household staff (only for those who plan).
function accounts(data) {
  const staff = data.people.filter((p) => data.balances[p.userId]);
  if (!staff.length) return null;
  return h('section', { class: 'accounts', 'aria-label': 'Urlaubskonten' }, staff.map((p) => {
    const b = data.balances[p.userId];
    return h('button', {
      class: 'stat', type: 'button', onclick: () => view.open?.(p.userId), title: `Kalender von ${p.name} öffnen`,
    },
    h('span', { class: 'stat-label' }, `${p.name}${p.job ? ` · ${p.job}` : ''}`),
    h('span', { class: 'stat-value' }, num(b.remaining)),
    h('span', { class: 'stat-sub' }, `Tage übrig${b.pending ? `, ${days(b.pending)} beantragt` : ''}`));
  }));
}

// "Heute weg" and "Diese Woche weg", from the loaded month.
function awayStrip(data) {
  const today = data.today;
  if (!today.startsWith(data.month)) return null;
  const monday = addDays(today, -weekdayIndex(today));
  const sunday = addDays(monday, 6);
  const names = (from, to) => {
    const list = [];
    for (const p of data.people) {
      const hits = data.entries.filter((e) => e.userId === p.userId && e.start <= to && e.end >= from);
      if (hits.length) list.push(`${p.name}${hits.every((e) => e.status === 'pending') ? ' (beantragt)' : ''}`);
    }
    return list.length ? list.join(', ') : 'niemand';
  };
  return h('section', { class: 'away' },
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Heute weg'), h('span', {}, names(today, today))),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Diese Woche weg'), h('span', {}, names(monday, sunday))));
}

function timeline(data, myId) {
  const holidays = new Map(data.holidays.map((x) => [x.date, x.name]));
  const closed = new Set();
  for (const c of data.closures) for (let d = c.start; d <= c.end; d = addDays(d, 1)) closed.add(d);
  const blocked = new Map(data.blocked.map((b) => [b.date, b]));
  const dayClass = (d) => [
    weekdayIndex(d.date) >= 5 ? 'weekend' : '',
    holidays.has(d.date) ? 'holiday' : '',
    closed.has(d.date) ? 'closure' : '',
    d.date === data.today ? 'today' : '',
  ].filter(Boolean).join(' ');
  const cols = data.days.length + 1;

  const head = h('tr', {},
    h('th', { scope: 'col', class: 'name' }, 'Name'),
    data.days.map((d) => h('th', {
      scope: 'col',
      class: dayClass(d),
      title: `${WEEKDAYS[weekdayIndex(d.date)]}, ${longDate(d.date)}${holidays.has(d.date) ? ` – ${holidays.get(d.date)}` : ''}`,
    }, h('span', { class: 'wd' }, WEEKDAYS[weekdayIndex(d.date)].slice(0, 2)), h('span', {}, String(Number(d.date.slice(8)))))));

  const group = (label) => h('tr', { class: 'group' }, h('th', { scope: 'rowgroup', colspan: String(cols) }, label));
  const family = data.people.filter((p) => p.role === 'family');
  const staff = data.people.filter((p) => p.role === 'household');
  const rows = [];
  if (family.length) {
    rows.push(group('Familie'));
    for (const p of family) rows.push(personRow(p, data, dayClass, myId, blocked));
  }
  rows.push(group('Kinder'));
  for (const [kind, label] of Object.entries(data.ferienKinds)) rows.push(ferienRow(kind, label, data, dayClass));
  if (staff.length) {
    rows.push(group('Personal'));
    for (const p of staff) rows.push(personRow(p, data, dayClass, myId, blocked));
  }

  const table = h('table', { class: `timeline${view.pick ? ' can-pick' : ''}`, onclick: pickCell, onkeydown: pickCell },
    h('caption', { class: 'sr-only' }, 'Urlaub, Ferien und Sperrzeiten, ein Tag pro Spalte'),
    h('thead', {}, head),
    h('tbody', {}, rows));
  return h('div', { class: 'timeline-wrap', tabindex: '0', role: 'region', 'aria-label': 'Monatsübersicht, seitlich scrollbar' }, table);
}

function ferienRow(kind, label, data, dayClass) {
  const list = data.ferien.filter((f) => f.kind === kind);
  return h('tr', { class: 'ferien-row' },
    h('th', { scope: 'row', class: 'name' }, label),
    data.days.map((d) => {
      const f = list.find((x) => x.start <= d.date && x.end >= d.date);
      const text = f ? `${f.label || label}${f.soft ? ' (Urlaub nach Absprache)' : ''}` : '';
      return h('td', { class: [dayClass(d), f ? 'ferien' : '', f?.soft ? 'soft' : ''].filter(Boolean).join(' '), title: text ? `${longDate(d.date)}: ${text}` : null },
        text ? h('span', { class: 'sr-only' }, text) : null);
    }));
}

function personRow(p, data, dayClass, myId, blocked) {
  const holidays = new Set(data.holidays.map((x) => x.date));
  const mine = data.entries.filter((e) => e.userId === p.userId);
  return h('tr', { class: p.userId === myId ? 'me' : '' },
    h('th', { scope: 'row', class: 'name' }, p.name, p.job ? h('span', { class: 'job' }, p.job) : null),
    data.days.map((d) => {
      const works = p.workPattern.includes(WD_KEYS[weekdayIndex(d.date)]);
      const hits = mine.filter((e) => e.start <= d.date && e.end >= d.date);
      const e = hits[0];
      const cls = [dayClass(d), works ? '' : 'free'];
      const said = [];
      const block = p.sperrzeiten && works && !holidays.has(d.date) ? blocked.get(d.date) : null;
      if (block) {
        cls.push('blocked', block.soft ? 'soft' : '');
        said.push(block.soft ? `${block.why}: Urlaub nur nach Absprache` : `Sperrzeit: ${block.why}`);
      }
      // Entries are only coloured on days the person would work.
      if (e && works && !holidays.has(d.date)) {
        const both = hits.length > 1 && hits.every((x) => x.half);
        cls.push('has-entry', `k-${e.kind}`, e.status === 'pending' ? 'pending' : '', e.half && !both ? `half-${e.half}` : '');
        if (e.substitute && e.status === 'approved') cls.push('has-sub');
        said.unshift(hits.map((x) => `${kindText(x, data.reasons)}${x.half ? ` (${HALF[x.half]})` : ''}, ${STATUS[x.status]}${x.substitute ? `, Vertretung: ${x.substitute}` : ''}`).join('; '));
      }
      const text = said.join('. ');
      const pickable = !!view.pick;
      return h('td', {
        class: cls.filter(Boolean).join(' '),
        title: text ? `${p.name}, ${longDate(d.date)}: ${text}` : (pickable ? `${p.name}, ${longDate(d.date)}: eintragen` : null),
        dataset: pickable ? { user: p.userId, date: d.date, entry: e ? e.id : '' } : null,
        tabindex: pickable ? '0' : null,
        'aria-label': pickable ? `${p.name}, ${longDate(d.date)}${text ? `: ${text}` : ''}` : null,
      }, text ? h('span', { class: 'sr-only' }, text) : null);
    }));
}
