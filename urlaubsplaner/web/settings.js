// "Einstellungen": people, the children's holidays and calendar, days off for everyone and
// the household settings. The assistant keeps people and holidays; logins, rights, the
// calendar link and the household settings are for the parents. The API checks it all.
import {
  WD_KEYS, WEEKDAYS, api, h, longDate, num, rangeText, showToast,
} from './ui.js';

const dialog = document.getElementById('extra-dialog');
const view = { year: null };

export function settingsPage({ today, myId, canApprove, onChanged }) {
  if (!view.year) view.year = Number(today.slice(0, 4));
  const section = h('section', { class: 'settings' }, h('h1', {}, 'Einstellungen'), h('p', { class: 'loading' }, 'Wird geladen …'));
  const ctx = { section, today, myId, canApprove, onChanged };
  load(ctx);
  return section;
}

async function load(ctx) {
  let people;
  let settings;
  let overview;
  try {
    [people, settings, overview] = await Promise.all([
      api('GET', `/api/people?year=${view.year}`),
      ctx.canApprove ? api('GET', '/api/settings') : Promise.resolve({}),
      api('GET', `/api/overview?year=${view.year}`),
    ]);
  } catch (err) {
    if (err.status !== 401) ctx.section.replaceChildren(h('h1', {}, 'Einstellungen'), h('p', { class: 'error', role: 'alert' }, err.message));
    return;
  }
  if (!people || !settings || !overview) return;
  const reload = () => { load(ctx); ctx.onChanged?.(); };
  const step = (delta) => () => { view.year += delta; load(ctx); };

  ctx.section.replaceChildren(
    h('div', { class: 'toolbar' },
      h('h1', {}, 'Einstellungen'),
      h('div', { class: 'pager' },
        h('button', { class: 'button icon', type: 'button', 'aria-label': 'Jahr davor', onclick: step(-1), disabled: view.year <= 2020 }, '‹'),
        h('h2', { class: 'pager-label', 'aria-live': 'polite' }, String(view.year)),
        h('button', { class: 'button icon', type: 'button', 'aria-label': 'Nächstes Jahr', onclick: step(1), disabled: view.year >= 2040 }, '›'))),
    ...[
      peopleSection(people, ctx, reload),
      ferienSection(overview.ferien, settings.kinderFeed, ctx, reload),
      ctx.canApprove ? feedSection(settings.kinderFeed, reload) : null,
      ctx.canApprove ? closuresSection(overview.closures, reload) : null,
      ctx.canApprove ? practiceSection(settings, reload) : null,
      importSection(reload),
    ].filter(Boolean),
  );
}

// ---------- helpers ----------

function openDialog(title, ...content) {
  dialog.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'extra-title' }, title), ...content));
  dialog.showModal();
  dialog.querySelector('input, select, textarea, button')?.focus();
}

function weekdayBoxes(name, selected) {
  return h('fieldset', { class: 'choices weekdays-pick' }, h('legend', {}, 'Arbeitstage'),
    WD_KEYS.map((k, i) => h('label', { class: 'choice' },
      h('input', { type: 'checkbox', name, value: k, checked: selected.includes(k) }),
      h('span', {}, WEEKDAYS[i].slice(0, 2)))));
}

function checked(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
}

function field(id, label, input, hint) {
  return h('div', { class: 'field' }, h('label', { for: id }, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), input);
}

function checkbox(id, label, isChecked, hint) {
  return h('label', { class: 'check', for: id },
    h('input', { type: 'checkbox', id, checked: isChecked }),
    h('span', {}, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null));
}

function numberInput(id, value, placeholder) {
  return h('input', {
    id, type: 'number', min: '0', max: '60', step: '0.5', inputmode: 'decimal', value: value ?? '', placeholder,
  });
}

function formActions(error, saveLabel = 'Speichern') {
  return [
    error,
    h('div', { class: 'actions' },
      h('button', { class: 'button primary', type: 'submit' }, saveLabel),
      h('button', { class: 'button', type: 'button', onclick: () => dialog.close() }, 'Abbrechen')),
  ];
}

const short = (iso) => iso.split('-').reverse().join('.');
const pattern = (keys) => keys.map((k) => WEEKDAYS[WD_KEYS.indexOf(k)].slice(0, 2)).join(', ');

// ---------- people ----------

function peopleSection(data, ctx, reload) {
  const rows = data.people.map((p) => h('tr', { class: p.active ? '' : 'inactive' },
    h('th', { scope: 'row' }, p.name, p.email ? h('span', { class: 'hint', title: p.email }, ' ✉') : null,
      p.active ? null : h('span', { class: 'badge declined' }, 'deaktiviert'),
      p.approver ? h('span', { class: 'badge approved' }, 'genehmigt') : null,
      p.planner ? h('span', { class: 'badge approved' }, 'trägt ein') : null,
      p.sperrzeiten ? h('span', { class: 'badge pending' }, 'Sperrzeiten') : null),
    h('td', {}, p.job || p.roleLabel, p.login ? h('span', { class: 'hint' }, ` · ${p.username}`) : h('span', { class: 'hint' }, ' · ohne Zugang')),
    h('td', {}, pattern(p.workPattern)),
    ...(p.role !== 'household' ? [h('td', {}, '–'), h('td', {}, '–'), h('td', {}, '–')] : [
      h('td', {}, p.startDate ? short(p.startDate) : h('span', { class: 'hint' }, 'fehlt')),
      h('td', {}, `${short(p.balance.yearStart)}–${short(p.balance.yearEnd)}`),
      h('td', {}, num(p.balance.allowance), p.allowanceOverride == null ? null : h('span', { class: 'hint' }, ' (fix)'),
      p.balance.carryOver > 0 ? h('span', { class: 'hint' }, ` + ${num(p.balance.carryOver)} Rest`) : null,
      p.balance.carryOver < 0 ? h('span', { class: 'hint' }, ` − ${num(-p.balance.carryOver)} überzogen`) : null)]),
    h('td', {}, p.role === 'household' ? num(p.balance.remaining) : '–', p.role === 'household' && p.balance.pending ? h('span', { class: 'hint' }, ` (${num(p.balance.pending)} beantragt)`) : null),
    h('td', {}, h('button', { class: 'link', type: 'button', onclick: () => editPerson(p, data, ctx, reload), 'aria-label': `${p.name} bearbeiten` }, 'Bearbeiten'))));

  return h('section', { class: 'card' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Personen'),
      h('button', { class: 'button primary', type: 'button', onclick: () => addPerson(data, ctx, reload) }, '+ Person hinzufügen')),
    h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Personen, seitlich scrollbar' },
      h('table', { class: 'people' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Aufgabe'), h('th', { scope: 'col' }, 'Arbeitstage'),
          h('th', { scope: 'col' }, 'Eintritt'), h('th', { scope: 'col' }, 'Urlaubsjahr'), h('th', { scope: 'col' }, 'Anspruch'),
          h('th', { scope: 'col' }, 'Übrig'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Aktionen')))),
        h('tbody', {}, rows))));
}

function roleSelect(id, roles, value) {
  return h('select', { id }, Object.entries(roles).map(([k, v]) => h('option', { value: k, selected: k === value }, v)));
}

function editPerson(p, data, ctx, reload) {
  const self = p.userId === ctx.myId;
  const error = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { id: 'p-name', maxlength: '80', value: p.name });
  const role = roleSelect('p-role', data.roles, p.role);
  const job = h('input', { id: 'p-job', maxlength: '80', value: p.job, placeholder: 'z. B. Reinigung, Garten, Nanny' });
  const start = h('input', { id: 'p-start', type: 'date', min: '2000-01-01', max: '2040-12-31', value: p.startDate });
  const email = h('input', { id: 'p-email', type: 'email', autocomplete: 'off', value: p.email });
  const allowance = numberInput('p-allowance', p.allowanceOverride, `automatisch: ${num(p.defaultAllowance)}`);
  const restDays = h('input', { id: 'p-rest', type: 'number', min: '-60', max: '120', step: '0.5', inputmode: 'decimal', value: p.rest ? p.rest.days : '' });
  const restAsOf = h('input', { id: 'p-rest-date', type: 'date', min: '2020-01-01', max: '2040-12-31', value: p.rest ? p.rest.asOf : ctx.today });
  const range = `${short(p.balance.yearStart)}–${short(p.balance.yearEnd)}`;
  const staffOnly = h('div', { class: 'dialog-form' },
    weekdayBoxes('p-days', p.workPattern),
    field('p-start', 'Eintrittsdatum', start, '(hier beginnt jedes Urlaubsjahr)'),
    h('div', { class: 'row' },
      field('p-rest', 'Resturlaub (Tage)', restDays),
      field('p-rest-date', 'Stand am', restAsOf)),
    h('p', { class: 'hint' }, 'Resturlaub laut Lohnverrechnung oder Liste. Ab diesem Tag rechnet der Planer selbst weiter; am Eintrittstag kommt jedes Jahr der neue Urlaub dazu. Leer lassen = nur nach Eintrittsdatum rechnen.'),
    field('p-allowance', `Urlaubsanspruch im Urlaubsjahr ${range}`, allowance, '(leer lassen = automatisch nach Arbeitstagen)'),
    checkbox('p-sperr', 'Sperrzeiten gelten', p.sperrzeiten, '(Ferien der Kinder und die Woche vor und nach dem Familienurlaub)'));
  const form = h('form', { class: 'dialog-form', novalidate: true },
    field('p-name', 'Name', name),
    field('p-role', 'Gruppe', role),
    field('p-job', 'Aufgabe', job),
    staffOnly,
    p.login ? field('p-email', 'E-Mail für Benachrichtigungen', email, '(bekommt Mails zu neuen Anträgen, wenn sie genehmigt)') : null,
    p.login && ctx.canApprove ? checkbox('p-approver', 'Darf Urlaub genehmigen', p.approver) : null,
    p.login && ctx.canApprove ? checkbox('p-planner', 'Trägt für alle ein (ohne zu genehmigen)', p.planner) : null,
    p.login && ctx.canApprove ? checkbox('p-active', 'Aktiv', p.active, '(deaktiviert = kann sich nicht mehr anmelden, Daten bleiben)') : null,
    !p.login ? checkbox('p-active', 'Aktiv', p.active, '(deaktiviert = erscheint nicht mehr in der Übersicht)') : null,
    ...formActions(error));
  const syncRole = () => { staffOnly.hidden = role.value !== 'household'; };
  role.addEventListener('change', syncRole);
  syncRole();
  if (self) for (const id of ['#p-active', '#p-approver', '#p-planner']) { const el = form.querySelector(id); if (el) el.disabled = true; }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    const body = {
      name: name.value,
      role: role.value,
      job: job.value,
      workPattern: checked(form, 'p-days'),
      startDate: start.value,
      yearStart: p.balance.yearStart,
      allowance: allowance.value === '' ? null : Number(allowance.value),
      sperrzeiten: form.querySelector('#p-sperr').checked,
      restDays: restDays.value === '' ? null : Number(restDays.value),
      restAsOf: restAsOf.value,
    };
    if (p.login) body.email = email.value;
    const flag = (id) => form.querySelector(id);
    if (!self && flag('#p-active')) body.active = flag('#p-active').checked;
    if (!self && flag('#p-approver')) body.approver = flag('#p-approver').checked;
    if (!self && flag('#p-planner')) body.planner = flag('#p-planner').checked;
    try {
      await api('PUT', `/api/people/${encodeURIComponent(p.userId)}`, body);
      dialog.close();
      showToast(`${body.name} gespeichert.`);
      reload();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  openDialog(`${p.name} bearbeiten`, form);
}

function addPerson(data, ctx, reload) {
  const error = h('p', { class: 'error', role: 'alert' });
  const username = h('input', { id: 'n-user', maxlength: '40', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const name = h('input', { id: 'n-name', maxlength: '80', autocomplete: 'off' });
  const role = roleSelect('n-role', data.roles, 'household');
  const job = h('input', { id: 'n-job', maxlength: '80', autocomplete: 'off', placeholder: 'z. B. Reinigung, Garten, Nanny' });
  const email = h('input', { id: 'n-email', type: 'email', autocomplete: 'off' });
  const start = h('input', { id: 'n-start', type: 'date', min: '2000-01-01', max: '2040-12-31' });
  const login = h('input', { type: 'checkbox', id: 'n-login' });
  const loginFields = h('div', { class: 'dialog-form' },
    field('n-user', 'Benutzername', username, '(zum Anmelden, klein geschrieben)'),
    field('n-email', 'Eigene E-Mail-Adresse', email, '(freiwillig)'),
    checkbox('n-approver', 'Darf Urlaub genehmigen', false),
    checkbox('n-planner', 'Trägt für alle ein (ohne zu genehmigen)', false));
  const staffOnly = h('div', { class: 'dialog-form' },
    weekdayBoxes('n-days', ['mon', 'tue', 'wed', 'thu', 'fri']),
    field('n-start', 'Eintrittsdatum', start, '(hier beginnt jedes Urlaubsjahr)'),
    checkbox('n-sperr', 'Sperrzeiten gelten', false, '(Ferien der Kinder und die Woche vor und nach dem Familienurlaub)'));
  const form = h('form', { class: 'dialog-form', novalidate: true },
    field('n-name', 'Name', name),
    field('n-role', 'Gruppe', role),
    field('n-job', 'Aufgabe', job),
    staffOnly,
    ctx.canApprove ? h('label', { class: 'check', for: 'n-login' }, login,
      h('span', {}, 'Bekommt einen Zugang', h('span', { class: 'hint' }, ' (Benutzername und Passwort, z. B. für die Organisation)'))) : null,
    loginFields,
    ...formActions(error, 'Hinzufügen'));
  const sync = () => {
    loginFields.hidden = !login.checked;
    staffOnly.hidden = role.value !== 'household';
  };
  login.addEventListener('change', sync);
  role.addEventListener('change', sync);
  sync();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    try {
      const res = await api('POST', '/api/people', {
        login: login.checked,
        username: username.value,
        name: name.value,
        role: role.value,
        job: job.value,
        workPattern: checked(form, 'n-days'),
        startDate: start.value,
        email: email.value,
        sperrzeiten: form.querySelector('#n-sperr').checked,
        approver: form.querySelector('#n-approver').checked,
        planner: form.querySelector('#n-planner').checked,
      });
      if (res.startPassword) showPassword(res.person, res.startPassword);
      else {
        dialog.close();
        showToast(`${res.person.name} hinzugefügt.`);
      }
      reload();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  openDialog('Person hinzufügen', form);
}

function showPassword(person, password) {
  openDialog('Zugang angelegt',
    h('p', {}, `Gib ${person.name} diese Daten persönlich. Das Start-Passwort siehst du nur jetzt.`),
    h('dl', { class: 'credentials' },
      h('dt', {}, 'Benutzername'), h('dd', {}, h('code', {}, person.username)),
      h('dt', {}, 'Start-Passwort'), h('dd', {}, h('code', {}, password))),
    h('p', { class: 'hint' }, 'Das Start-Passwort gilt 7 Tage. Beim ersten Anmelden wählt die Person ein eigenes Passwort (mindestens 12 Zeichen).'),
    h('div', { class: 'actions' }, h('button', { class: 'button primary', type: 'button', onclick: () => dialog.close() }, 'Fertig')));
}

// ---------- the children's holidays ----------

function ferienSection(ferien, feed, ctx, reload) {
  const kinds = { school: 'Schule', kindergarten: 'Kindergarten' };
  const manual = ferien.filter((f) => !f.fromCalendar);
  const fromCal = ferien.filter((f) => f.fromCalendar);
  const item = (f) => h('li', {},
    h('div', {},
      h('strong', {}, rangeText(f)),
      h('span', {}, ` · ${f.label || 'Ferien'}`),
      h('span', { class: 'tag-chip' }, kinds[f.kind]),
      f.soft ? h('span', { class: 'hint' }, ' · Urlaub nach Absprache') : null),
    f.fromCalendar ? h('span', { class: 'hint' }, 'aus dem Kinder-Kalender') : h('div', { class: 'actions' },
      h('button', { class: 'button small', type: 'button', onclick: () => editFerien(f, reload) }, 'Bearbeiten'),
      h('button', {
        class: 'button small danger', type: 'button',
        onclick: async () => {
          if (!window.confirm(`${f.label || 'Ferien'} ${rangeText(f)} löschen?`)) return;
          try {
            await api('DELETE', `/api/ferien/${f.id}`);
            showToast('Gelöscht.');
            reload();
          } catch (err) {
            showToast(err.message);
          }
        },
      }, 'Löschen')));
  return h('section', { class: 'card' },
    h('div', { class: 'section-head' },
      h('h2', {}, `Freie Tage der Kinder ${view.year}`),
      h('div', { class: 'actions' },
        h('button', { class: 'button', type: 'button', onclick: () => syncFeed(reload) }, 'Kinder-Kalender jetzt abgleichen'),
        h('button', { class: 'button primary', type: 'button', onclick: () => editFerien(null, reload) }, '+ Von Hand eintragen'))),
    h('p', { class: 'hint' }, 'Die freien Tage kommen automatisch aus dem Kinder-Kalender (alle 3 Stunden). Was dort fehlt, kannst du hier von Hand ergänzen. Für Personen mit Sperrzeiten ist an diesen Tagen kein Urlaub möglich, auch im Sommer.'),
    feed && !feed.url && ctx.canApprove ? h('p', { class: 'notice' }, 'Noch kein Kinder-Kalender verbunden. Siehe „Kinder-Kalender“ weiter unten.') : null,
    fromCal.length || manual.length
      ? h('ul', { class: 'plain ferien-list' }, [...manual, ...fromCal].sort((a, b) => a.start.localeCompare(b.start)).map(item))
      : h('p', {}, 'In diesem Jahr noch keine freien Tage.'));
}

async function syncFeed(reload) {
  try {
    const r = await api('POST', '/api/kinder-kalender/abgleich');
    showToast(r.error || `Abgeglichen: ${r.count} freie Zeiträume im Kinder-Kalender.`);
    reload();
  } catch (err) {
    showToast(err.message);
  }
}

function editFerien(f, reload) {
  const error = h('p', { class: 'error', role: 'alert' });
  const kind = h('select', { id: 'f-kind' },
    h('option', { value: 'school', selected: f?.kind !== 'kindergarten' }, 'Schule'),
    h('option', { value: 'kindergarten', selected: f?.kind === 'kindergarten' }, 'Kindergarten'));
  const start = h('input', { id: 'f-start', type: 'date', min: '2020-01-01', max: '2040-12-31', value: f?.start || '' });
  const end = h('input', { id: 'f-end', type: 'date', min: '2020-01-01', max: '2040-12-31', value: f?.end || '' });
  const label = h('input', { id: 'f-label', maxlength: '80', value: f?.label || '', placeholder: 'z. B. Herbstferien' });
  const form = h('form', { class: 'dialog-form', novalidate: true },
    field('f-kind', 'Für', kind),
    h('div', { class: 'row' }, field('f-start', 'Von', start), field('f-end', 'Bis', end)),
    field('f-label', 'Bezeichnung', label),
    checkbox('f-soft', 'Urlaub nach Absprache möglich', f ? f.soft : false, '(wie im Sommer)'),
    ...formActions(error));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    const body = { kind: kind.value, start: start.value, end: end.value, label: label.value, soft: form.querySelector('#f-soft').checked };
    try {
      if (f) await api('PUT', `/api/ferien/${f.id}`, body);
      else await api('POST', '/api/ferien', body);
      dialog.close();
      showToast('Gespeichert.');
      reload();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  openDialog(f ? 'Freie Tage bearbeiten' : 'Freie Tage eintragen', form);
}

// ---------- the children's calendar (parents) ----------

function feedSection(feed, reload) {
  const error = h('p', { class: 'error', role: 'alert' });
  const url = h('input', { id: 'k-url', type: 'url', autocomplete: 'off', spellcheck: 'false', value: feed.url, placeholder: 'webcal://…' });
  const free = h('input', { id: 'k-free', value: feed.words.free });
  const kiga = h('input', { id: 'k-kiga', value: feed.words.kindergarten });
  const status = feed.url
    ? (feed.error ? h('p', { class: 'notice' }, feed.error)
      : h('p', { class: 'summary' }, feed.fetchedAt
        ? `Verbunden. Zuletzt gelesen am ${longDate(feed.fetchedAt.slice(0, 10))}: ${feed.count} freie Zeiträume gefunden.`
        : 'Verbunden, noch nicht gelesen.'))
    : null;
  const form = h('form', { class: 'practice-form', novalidate: true },
    h('p', { class: 'hint' }, 'So bekommst du den Link (iPhone): Kalender-App → unten „Kalender“ → beim Kalender „KINDER“ auf ⓘ tippen → „Öffentlicher Kalender“ einschalten → „Link teilen…“ → „Kopieren“. Dann hier einfügen. Der Link ist wie ein Schlüssel: nicht weitergeben.'),
    field('k-url', 'Link zum Kinder-Kalender', url),
    status,
    field('k-free', 'Diese Wörter heißen „Kinder haben frei“', free, '(mit Komma getrennt, Groß- und Kleinschreibung egal)'),
    field('k-kiga', 'Diese Wörter heißen „Kindergarten“', kiga, '(alles andere zählt als Schule)'),
    error,
    h('div', { class: 'actions' },
      h('button', { class: 'button primary', type: 'submit' }, 'Speichern und abgleichen'),
      feed.url ? h('button', {
        class: 'button danger', type: 'button',
        onclick: async () => {
          if (!window.confirm('Kinder-Kalender trennen? Die freien Tage daraus verschwinden aus dem Planer.')) return;
          try {
            await api('PUT', '/api/kinder-kalender', { url: '' });
            showToast('Getrennt.');
            reload();
          } catch (err) {
            error.textContent = err.message;
          }
        },
      }, 'Trennen') : null));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    try {
      const r = await api('PUT', '/api/kinder-kalender', { url: url.value, words: { free: free.value, kindergarten: kiga.value } });
      showToast(r.error || `Gespeichert: ${r.count} freie Zeiträume gefunden.`);
      reload();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return h('section', { class: 'card' }, h('div', { class: 'section-head' }, h('h2', {}, 'Kinder-Kalender')), form);
}

// ---------- days off for everyone (parents) ----------

function closuresSection(closures, reload) {
  return h('section', { class: 'card' },
    h('div', { class: 'section-head' },
      h('h2', {}, `Alle frei ${view.year}`),
      h('button', { class: 'button primary', type: 'button', onclick: () => editClosure(null, reload) }, '+ Freie Tage für alle')),
    h('p', { class: 'hint' }, 'An diesen Tagen hat das ganze Personal frei, z. B. zwischen Weihnachten und Neujahr. Niemand muss dafür Urlaub beantragen.'),
    closures.length
      ? h('ul', { class: 'plain closure-list' }, closures.map((c) => h('li', {},
        h('div', {},
          h('strong', {}, rangeText(c)),
          c.label ? h('span', {}, ` · ${c.label}`) : null,
          h('span', { class: 'hint' }, c.countsAsVacation ? ' · zählt als Urlaub' : ' · zählt nicht als Urlaub')),
        h('div', { class: 'actions' },
          h('button', { class: 'button small', type: 'button', onclick: () => editClosure(c, reload) }, 'Bearbeiten'),
          h('button', {
            class: 'button small danger', type: 'button',
            onclick: async () => {
              if (!window.confirm(`Freie Tage ${rangeText(c)} löschen?`)) return;
              try {
                await api('DELETE', `/api/closures/${c.id}?rev=${c.rev}`);
                showToast('Gelöscht.');
                reload();
              } catch (err) {
                showToast(err.message);
              }
            },
          }, 'Löschen')))))
      : h('p', {}, 'Keine.'));
}

function editClosure(c, reload) {
  const error = h('p', { class: 'error', role: 'alert' });
  const start = h('input', { id: 'c-start', type: 'date', min: '2020-01-01', max: '2040-12-31', value: c?.start || `${view.year}-12-24` });
  const end = h('input', { id: 'c-end', type: 'date', min: '2020-01-01', max: '2040-12-31', value: c?.end || `${view.year + 1}-01-06` });
  const label = h('input', { id: 'c-label', maxlength: '80', value: c?.label || '', placeholder: 'z. B. Weihnachten' });
  const form = h('form', { class: 'dialog-form', novalidate: true },
    h('div', { class: 'row' }, field('c-start', 'Von', start), field('c-end', 'Bis', end)),
    field('c-label', 'Bezeichnung', label),
    checkbox('c-counts', 'Zählt als Urlaub', c ? c.countsAsVacation : false, '(wird allen an ihren Arbeitstagen vom Urlaub abgezogen)'),
    ...formActions(error));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    const body = {
      start: start.value, end: end.value, label: label.value, substitute: '',
      countsAsVacation: form.querySelector('#c-counts').checked,
    };
    try {
      if (c) await api('PUT', `/api/closures/${c.id}`, { ...body, expectedRev: c.rev });
      else await api('POST', '/api/closures', body);
      dialog.close();
      showToast('Gespeichert.');
      reload();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  openDialog(c ? 'Freie Tage für alle bearbeiten' : 'Freie Tage für alle', form);
}

// ---------- practice ----------

function practiceSection(s, reload) {
  const error = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { id: 's-name', maxlength: '80', value: s.practiceName });
  const allowance = numberInput('s-allowance', s.defaultAllowance);
  const form = h('form', { class: 'practice-form', novalidate: true },
    field('s-name', 'Name', name, '(steht im Kalender-Abo)'),
    field('s-allowance', 'Urlaubsanspruch bei 5 Arbeitstagen', allowance, '(Teilzeit wird automatisch umgerechnet)'),
    checkbox('s-approve', 'Andere Abwesenheiten (z. B. Kurs) müssen bestätigt werden', s.absenceNeedsApproval),
    error,
    h('div', { class: 'actions' }, h('button', { class: 'button primary', type: 'submit' }, 'Speichern')),
    h('div', { class: 'mail-test' },
      h('h3', {}, 'E-Mails bei neuen Anträgen'),
      h('p', { class: 'hint' }, s.mailEnabled
        ? 'Eingeschaltet. Mails gehen an alle, die genehmigen und eine E-Mail-Adresse hinterlegt haben.'
        : 'Ausgeschaltet. Neue Anträge siehst du unter „Anträge“.'),
      s.mailEnabled ? h('button', {
        class: 'button', type: 'button',
        onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            const r = await api('POST', '/api/mail-test');
            showToast(`Test-E-Mail an ${r.sentTo} gesendet.`);
          } catch (err) {
            showToast(err.message);
          } finally {
            ev.target.disabled = false;
          }
        },
      }, 'Test-E-Mail an mich senden') : null));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    try {
      await api('PUT', '/api/settings', {
        practiceName: name.value,
        defaultAllowance: Number(allowance.value),
        absenceNeedsApproval: form.querySelector('#s-approve').checked,
      });
      showToast('Einstellungen gespeichert.');
      reload();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return h('section', { class: 'card' }, h('div', { class: 'section-head' }, h('h2', {}, 'Haushalt')), form);
}

// ---------- taking over an existing leave plan ----------

function importSection(reload) {
  const text = h('textarea', { id: 'imp-text', rows: '6', spellcheck: 'false', placeholder: '{ "people": [ … ], "entries": [ … ] }' });
  const result = h('div', { class: 'import-result', 'aria-live': 'polite' });
  const run = (dryRun) => async () => {
    result.replaceChildren();
    let body;
    try {
      body = JSON.parse(text.value);
    } catch {
      result.append(h('p', { class: 'error' }, 'Der Text ist nicht vollständig. Bitte genau so einfügen, wie Claude ihn geschickt hat.'));
      return;
    }
    try {
      const r = await api('POST', '/api/import', { ...body, dryRun });
      const block = (title, items, cls = '') => (items.length
        ? h('div', { class: cls }, h('h3', {}, `${title} (${items.length})`), h('ul', {}, items.map((i) => h('li', {}, i))))
        : null);
      const nothing = !r.people.length && !r.closures.length && !r.entries.length;
      result.append(...[
        h('p', { class: r.problems.length ? 'notice' : 'summary' }, dryRun
          ? (r.problems.length ? 'Geprüft. Ein paar Zeilen gehen nicht, siehe unten. Der Rest kann übernommen werden.' : 'Geprüft, alles in Ordnung. Noch ist nichts gespeichert.')
          : (nothing ? 'Nichts Neues zu übernehmen.' : 'Übernommen. Die Einträge sind bestätigt.')),
        block('Probleme', r.problems, 'problems'),
        block(dryRun ? 'Personen, die angepasst werden' : 'Angepasste Personen', r.people),
        block(dryRun ? 'Freie Tage für alle, die eingetragen werden' : 'Eingetragene freie Tage für alle', r.closures),
        block(dryRun ? 'Urlaube, die eingetragen werden' : 'Eingetragene Urlaube', r.entries),
        block('Schon vorhanden, wird übersprungen', r.skipped),
      ].filter(Boolean));
      if (!dryRun) {
        showToast('Urlaubsplanung übernommen.');
        reload();
      }
    } catch (err) {
      result.append(h('p', { class: 'error', role: 'alert' }, err.message));
    }
  };
  return h('section', { class: 'card import' },
    h('h2', {}, 'Startdaten übernehmen'),
    h('p', { class: 'hint' }, 'Füge hier den Text ein, den Claude vorbereitet hat (Personen, Eintritt, Resturlaub, schon vereinbarter Urlaub). Zuerst „Prüfen“: Dann siehst du, was passiert, und es wird noch nichts gespeichert. Doppeltes wird übersprungen.'),
    h('div', { class: 'field' }, h('label', { for: 'imp-text' }, 'Text aus der Liste'), text),
    h('div', { class: 'actions' },
      h('button', { class: 'button', type: 'button', onclick: run(true) }, 'Prüfen'),
      h('button', { class: 'button primary', type: 'button', onclick: run(false) }, 'Übernehmen')),
    result);
}
