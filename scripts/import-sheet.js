// Imports the Google Sheet export (data/sheet-export.json) into the database.
//
//   node scripts/import-sheet.js data/sheet-export.json
//   node scripts/import-sheet.js data/sheet-export.json --db /data/timeoff.sqlite --replace
//
// Days before --reported-before (default: today) are marked reported, since they
// were already on your timesheet. Later days start unreported.
// It refuses to run on a database that already has entries unless --replace is given.

import { readFileSync } from "node:fs";
import { openDb, needsReport, HOURS_PER_DAY } from "../server/db.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const VALUE_FLAGS = ["--db", "--reported-before"];
const file = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
if (!file) {
  console.error("Usage: node scripts/import-sheet.js <sheet-export.json> [--db file] [--replace] [--reported-before YYYY-MM-DD]");
  process.exit(1);
}
const dbFile = flag("--db", process.env.DB_FILE || "data/timeoff.sqlite");
const cutoff = flag("--reported-before", new Date().toISOString().slice(0, 10));
const replace = args.includes("--replace");

// The sheet has M/D/YYYY, MM/DD/YYYY and M/D/YY.
function toIso(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const sheet = JSON.parse(readFileSync(file, "utf8"));
const entries = [];
const problems = [];
for (const [tab, rows] of Object.entries(sheet.years)) {
  rows.slice(2).forEach((r, i) => {
    const [, date, hours, type, reason] = r;
    if (!date) return;
    const iso = toIso(date);
    if (!iso) return problems.push(`${tab} row ${i + 3}: "${date}" is not a date; skipped`);
    if (iso.slice(0, 4) !== tab) problems.push(`${tab} row ${i + 3}: ${iso} is filed under ${tab}; imported by its own date`);
    const e = { date: iso, hours: Number(hours) || 0, type: String(type || "").trim(), reason: String(reason || "").trim() };
    if (!e.type) problems.push(`${tab} row ${i + 3}: ${iso} has no type`);
    e.reported = needsReport(e) && iso < cutoff;
    entries.push(e);
  });
}

const db = openDb(dbFile);
if (db.count() && !replace) {
  console.error(`${dbFile} already has ${db.count()} entries. Run again with --replace to wipe them and import.`);
  process.exit(1);
}

db.tx(() => {
  if (replace) db.clearAll();
  for (const e of entries) db.insert(e);
  // Years with no rows in the sheet (2015 to 2018) keep their total from the Totals tab.
  const haveRows = new Set(entries.map((e) => e.date.slice(0, 4)));
  for (const [year, hours] of sheet.totals) if (!haveRows.has(year)) db.putYearTotal(Number(year), Number(hours));
});
if (sheet.expectedDays || sheet.types) db.saveSettings({ expectedDays: sheet.expectedDays, types: sheet.types });

// Check the import against the sheet's own Totals tab.
const summary = new Map(db.summary().map((y) => [String(y.year), y]));
for (const [year, hours] of sheet.totals) {
  const got = summary.get(year)?.hours ?? 0;
  if (Math.abs(got - Number(hours)) > 0.001) problems.push(`${year}: sheet total is ${hours} hours, imported ${got}`);
}

const reported = entries.filter((e) => e.reported).length;
const open = entries.filter((e) => needsReport(e) && !e.reported).length;
console.log(`Imported ${entries.length} entries into ${dbFile}.`);
console.log(`${reported} marked reported (before ${cutoff}), ${open} not reported yet.`);
console.log(`Years: ${[...summary.keys()].sort().map((y) => `${y} ${summary.get(y).hours / HOURS_PER_DAY}d`).join(", ")}`);
if (problems.length) console.log(`\nWorth a look:\n- ${problems.join("\n- ")}`);
db.close();
