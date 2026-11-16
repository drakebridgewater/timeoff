import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_TYPES = ["PTO/FTO", "Sick", "Holiday", "Volunteering", "Paternity Leave", "Floating Holiday"];
export const DEFAULT_EXPECTED_DAYS = 24;
export const HOURS_PER_DAY = 8;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A company holiday with no hours is not something you tell your employer about.
// Everything else is: PTO, sick days, volunteering (even at 0 hours) and an
// 8-hour "Holiday" that is really a day off.
export const needsReport = (e) => !(e.type === "Holiday" && !(e.hours > 0));

export function isIsoDate(s) {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const row = (r) =>
  r && {
    id: r.id,
    date: r.date,
    hours: r.hours,
    type: r.type,
    reason: r.reason,
    reported: !!r.reported,
    reportedAt: r.reported_at,
    needsReport: needsReport(r),
  };

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      hours REAL NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      reported INTEGER NOT NULL DEFAULT 0,
      reported_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_date ON entries (date);
    -- Years kept only as a total (the sheet's Totals tab before 2019).
    CREATE TABLE IF NOT EXISTS year_totals (
      year INTEGER PRIMARY KEY,
      hours REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const q = {
    get: db.prepare("SELECT * FROM entries WHERE id = ?"),
    year: db.prepare("SELECT * FROM entries WHERE date >= ? AND date < ? ORDER BY date, id"),
    between: db.prepare("SELECT * FROM entries WHERE date >= ? AND date <= ? ORDER BY date, id"),
    all: db.prepare("SELECT * FROM entries ORDER BY date, id"),
    count: db.prepare("SELECT COUNT(*) AS n FROM entries"),
    insert: db.prepare(
      "INSERT INTO entries (date, hours, type, reason, reported, reported_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    update: db.prepare(
      "UPDATE entries SET date = ?, hours = ?, type = ?, reason = ?, reported = ?, reported_at = ?, updated_at = ? WHERE id = ?",
    ),
    del: db.prepare("DELETE FROM entries WHERE id = ?"),
    years: db.prepare(`
      SELECT CAST(substr(date, 1, 4) AS INTEGER) AS year, SUM(hours) AS hours, COUNT(*) AS entries
      FROM entries GROUP BY year`),
    totals: db.prepare("SELECT year, hours FROM year_totals"),
    putTotal: db.prepare("INSERT INTO year_totals (year, hours) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET hours = excluded.hours"),
    getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
    putSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  };

  const now = () => new Date().toISOString();

  function getSettings() {
    const read = (k, fallback) => {
      const r = q.getSetting.get(k);
      return r ? JSON.parse(r.value) : fallback;
    };
    return { expectedDays: read("expectedDays", DEFAULT_EXPECTED_DAYS), types: read("types", DEFAULT_TYPES) };
  }

  function saveSettings(s) {
    const cur = getSettings();
    const next = { ...cur, ...s };
    q.putSetting.run("expectedDays", JSON.stringify(next.expectedDays));
    q.putSetting.run("types", JSON.stringify(next.types));
    return next;
  }

  function insert(e) {
    const t = now();
    const r = q.insert.run(e.date, e.hours, e.type, e.reason, e.reported ? 1 : 0, e.reported ? e.reportedAt || t : null, t, t);
    return row(q.get.get(r.lastInsertRowid));
  }

  function update(id, patch) {
    const cur = q.get.get(id);
    if (!cur) return null;
    const next = { ...row(cur), ...patch };
    // Keep the first time it was marked reported; clear it when unmarked.
    const reportedAt = next.reported ? cur.reported_at || now() : null;
    q.update.run(next.date, next.hours, next.type, next.reason, next.reported ? 1 : 0, reportedAt, now(), id);
    return row(q.get.get(id));
  }

  function listYear(year) {
    return q.year.all(`${year}-01-01`, `${year + 1}-01-01`).map(row);
  }

  function summary() {
    const byYear = new Map();
    for (const t of q.totals.all()) byYear.set(t.year, { year: t.year, hours: t.hours, entries: 0, unreported: 0, totalOnly: true });
    for (const y of q.years.all()) byYear.set(y.year, { year: y.year, hours: y.hours, entries: y.entries, unreported: 0, totalOnly: false });
    for (const e of q.all.all().map(row)) {
      if (e.needsReport && !e.reported) byYear.get(Number(e.date.slice(0, 4))).unreported++;
    }
    return [...byYear.values()].sort((a, b) => b.year - a.year).map((y) => ({ ...y, days: y.hours / HOURS_PER_DAY }));
  }

  // Runs fn inside one transaction; any throw rolls the whole thing back.
  function tx(fn) {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    get: (id) => row(q.get.get(id)),
    all: () => q.all.all().map(row),
    count: () => q.count.get().n,
    listYear,
    between: (from, to) => q.between.all(from, to).map(row),
    summary,
    insert,
    insertMany: (list) => tx(() => list.map(insert)),
    update,
    markReported: (ids) => tx(() => ids.map((id) => update(id, { reported: true })).filter(Boolean)),
    remove: (id) => q.del.run(id).changes > 0,
    putYearTotal: (year, hours) => q.putTotal.run(year, hours),
    clearAll: () => db.exec("DELETE FROM entries; DELETE FROM year_totals;"),
    tx,
    getSettings,
    saveSettings,
    close: () => db.close(),
  };
}
