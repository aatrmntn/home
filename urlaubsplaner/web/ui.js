// Shared helpers for all pages: building elements safely, dates for display, API calls.
// All text is set as text nodes, never as HTML.
import { authHeaders, refresh } from './auth.js';

export const MONTHS = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August',
  'September', 'Oktober', 'November', 'Dezember'];
export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WD_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const STATUS = { pending: 'beantragt', approved: 'bestätigt', declined: 'abgelehnt' };
export const HALF = { am: 'Vormittag', pm: 'Nachmittag' };

const toast = document.getElementById('toast');
let signedOut = () => {};
export function onSignedOut(fn) {
  signedOut = fn;
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = true;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const num = (n) => n.toLocaleString('de-AT', { maximumFractionDigits: 1 });
export const days = (n) => `${num(n)} ${n === 1 ? 'Tag' : 'Tage'}`;
export const isoOf = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const dateOf = (iso) => new Date(`${iso}T00:00:00Z`);
export const weekdayIndex = (iso) => (dateOf(iso).getUTCDay() + 6) % 7; // Monday = 0

export function addDays(iso, n) {
  const d = dateOf(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function longDate(iso, withYear = true) {
  const d = dateOf(iso);
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
}

export function rangeText(e) {
  if (e.start === e.end) return `${longDate(e.start)}${e.half ? `, ${HALF[e.half]}` : ''}`;
  const sameYear = e.start.slice(0, 4) === e.end.slice(0, 4);
  return `${longDate(e.start, !sameYear)} – ${longDate(e.end)}`;
}

export function kindText(e, reasons) {
  if (e.kind === 'vacation') return e.half ? 'Urlaub, halber Tag' : 'Urlaub';
  return reasons[e.reason] || 'Abwesenheit';
}

export function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 4000);
}

export async function api(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { ...(await authHeaders()) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && attempt === 0 && await refresh()) continue;
    if (res.status === 401) {
      signedOut();
      throw Object.assign(new Error('Bitte melde dich wieder an.'), { status: 401 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Etwas ist schiefgelaufen.'), { status: res.status });
    return data.item;
  }
  return null;
}

// Downloads a file from the API (with the login) and hands it to the browser.
export async function download(path, filename) {
  const res = await fetch(path, { headers: await authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Der Download hat nicht geklappt.');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function weekdayDate(iso) {
  return `${WEEKDAYS[weekdayIndex(iso)]}, ${longDate(iso)}`;
}
