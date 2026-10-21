// In-memory storage with the same interface as api/db-dynamo.js. Used by tests and `npm run dev`.
import { ConflictError } from '../api/errors.js';
import { addDays } from '../api/rules.js';

const copy = (x) => (x == null ? x : structuredClone(x));

export function createMemoryDb({ people = [], entries = [], settings: initialSettings = {} } = {}) {
  const settings = copy(initialSettings);
  const P = new Map(people.map((p) => [p.userId, copy(p)]));
  const E = new Map(entries.map((e) => [e.id, copy(e)]));
  const audit = [];

  return {
    audit,
    async getPerson(userId) { return copy(P.get(userId) || null); },
    async listPeople() { return [...P.values()].map(copy); },
    async putPerson(person, record) {
      P.set(person.userId, copy(person));
      if (record) audit.push(copy(record));
    },
    async getSettings() { return copy(settings); },
    async putSettings(next, record) {
      Object.assign(settings, copy(next));
      audit.push(copy(record));
    },
    async purgeAudit(before) {
      const keep = audit.filter((a) => a.at >= before);
      const removed = audit.length - keep.length;
      audit.splice(0, audit.length, ...keep);
      return removed;
    },
    async getEntry(id) { return copy(E.get(id) || null); },
    async listUserEntries(userId, from, to) {
      const earliest = addDays(from, -92);
      return [...E.values()]
        .filter((e) => e.userId === userId && e.start >= earliest && e.start <= to && e.end >= from)
        .map(copy);
    },
    async listYearEntries(year) {
      const first = `${year}-01-01`;
      return [...E.values()]
        .filter((e) => Number(e.start.slice(0, 4)) >= year - 1 && Number(e.start.slice(0, 4)) <= year && e.end >= first)
        .map(copy);
    },
    async createEntry(entry, record) {
      if (E.has(entry.id)) throw new ConflictError();
      E.set(entry.id, copy(entry));
      audit.push(copy(record));
    },
    async updateEntry(entry, expectedRev, record) {
      if (E.get(entry.id)?.rev !== expectedRev) throw new ConflictError();
      E.set(entry.id, copy(entry));
      audit.push(copy(record));
    },
    async deleteEntry(id, expectedRev, record) {
      if (E.get(id)?.rev !== expectedRev) throw new ConflictError();
      E.delete(id);
      audit.push(copy(record));
    },
  };
}
