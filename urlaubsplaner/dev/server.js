// Local copy for trying things out: `npm run dev`, then open http://localhost:8080.
// In-memory data (gone on restart) and a person picker instead of the real login.
// Never deployed; production runs api/handler.js behind Cognito.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../api/app.js';
import { addDays, todayIn } from '../api/rules.js';
import { createMemoryDb } from './memory-db.js';

const PORT = Number(process.env.PORT) || 8080;
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const FULL = ['mon', 'tue', 'wed', 'thu', 'fri'];

// Shaped like the household: two parents who approve, an assistant who enters for
// everyone, three household staff without login. Names are made up.
const team = [
  { userId: 'dev-lea', name: 'Lea', role: 'family', approver: true, workPattern: FULL, email: 'lea@example.at' },
  { userId: 'dev-tom', name: 'Tom', role: 'family', approver: true, workPattern: FULL },
  { userId: 'dev-eva', name: 'Eva', role: 'office', planner: true, workPattern: FULL },
  { userId: 'ohne-zugang-petra', name: 'Petra', job: 'Reinigung', role: 'household', login: false, sperrzeiten: true, workPattern: FULL, startDate: '2025-10-30' },
  { userId: 'ohne-zugang-karl', name: 'Karl', job: 'Garten', role: 'household', login: false, workPattern: ['mon', 'wed', 'fri'], startDate: '2026-03-25' },
  { userId: 'ohne-zugang-nina', name: 'Nina', job: 'Nanny', role: 'household', login: false, workPattern: FULL, startDate: '2025-11-10' },
];
const LABELS = { family: 'Eltern, genehmigt', office: 'Organisation, trägt ein', household: 'Personal' };

const today = todayIn();
const year = today.slice(0, 4);
const at = new Date().toISOString();
const seed = (n, userId, start, end, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  userId, kind: 'vacation', reason: '', start, end, half: '', note: '', status: 'approved', rev: 1,
  createdAt: at, updatedAt: at, ...extra,
});
const ferien = (id, kind, label, start, end) => ({ id: `00000000-0000-4000-9000-${String(id).padStart(12, '0')}`, kind, label, start, end, soft: false });

const db = createMemoryDb({
  people: team.map((p) => ({ ...p, username: p.login === false ? '' : p.name.toLowerCase(), active: true, allowances: {} })),
  settings: {
    ferien: [
      ferien(1, 'school', 'Herbstferien', addDays(today, -2), addDays(today, 5)),
      ferien(2, 'kindergarten', 'Kindergarten geschlossen', addDays(today, 1), addDays(today, 2)),
      ferien(3, 'school', 'Thanksgiving, kein Unterricht', addDays(today, 36), addDays(today, 37)),
      ferien(4, 'school', 'Winterferien', `${year}-12-19`, `${Number(year) + 1}-01-10`),
      ferien(5, 'kindergarten', 'Weihnachtsferien', `${year}-12-24`, `${Number(year) + 1}-01-03`),
    ],
  },
  entries: [
    seed(1, 'dev-lea', addDays(today, 20), addDays(today, 27)),
    seed(2, 'dev-tom', addDays(today, 20), addDays(today, 27)),
    seed(3, 'ohne-zugang-karl', addDays(today, 6), addDays(today, 9), { substitute: 'Nachbar Franz' }),
    seed(4, 'ohne-zugang-petra', addDays(today, 29), addDays(today, 31), { status: 'pending', note: 'Hochzeit Schwester' }),
    seed(5, 'ohne-zugang-nina', addDays(today, 40), addDays(today, 44), { status: 'pending' }),
  ],
});
// Emails are only printed here, never sent.
const notify = async ({ to, subject, text }) => {
  console.log(`\n[E-Mail, Testversion] an ${to.join(', ')}: ${subject}\n${text}\n`);
};
// A stand-in for the login system: people added in the app can be picked on the start page.
let added = 0;
const directory = {
  async createUser() {
    added += 1;
    return { userId: `dev-new${added}`, startPassword: 'Testversion-Start1' };
  },
  async setEnabled() {},
  async setGroup() {},
};
const app = createApp({ db, notify, directory, appUrl: `http://localhost:${PORT}/` });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};
const SECURITY = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/config.json') {
      const users = (await db.listPeople()).filter((p) => p.active !== false && p.login !== false)
        .map((p) => ({ id: p.userId, name: p.name, label: LABELS[p.role] }));
      return send(res, 200, TYPES['.json'], JSON.stringify({ mode: 'dev', users }));
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/feed/')) {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, TYPES['.json'], JSON.stringify({ error: 'Die Anfrage konnte nicht gelesen werden.' }));
      }
      const person = req.headers['x-dev-user'] ? await db.getPerson(String(req.headers['x-dev-user'])) : null;
      const out = await app.handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        user: person ? { id: person.userId, groups: [person.approver ? 'approver' : person.planner ? 'planner' : 'staff'] } : null,
      });
      if (out.raw !== undefined) {
        res.writeHead(out.status, {
          'content-type': out.contentType,
          'cache-control': 'no-store',
          ...(out.filename ? { 'content-disposition': `attachment; filename="${out.filename}"` } : {}),
          ...SECURITY,
        });
        return res.end(out.raw);
      }
      return send(res, out.status, TYPES['.json'], JSON.stringify(out.body));
    }
    const file = normalize(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(WEB)) return send(res, 404, 'text/plain', 'Not found');
    const data = await readFile(file);
    return send(res, 200, TYPES[extname(file)] || 'application/octet-stream', data);
  } catch {
    return send(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Urlaubsplaner (Testversion) läuft auf http://localhost:${PORT}`);
});
