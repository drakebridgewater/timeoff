import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../server/index.js";

// Closed at the end even when a test fails before its own close().
const servers = [];
after(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

async function start() {
  const app = createApp({ dbFile: ":memory:", version: "test" });
  const server = createServer(app.handler);
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, opts = {}) => {
    const res = await fetch(base + path, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, headers: res.headers };
  };
  return { call, close: () => (server.closeAllConnections(), server.close()) };
}

test("adds a range of weekdays and skips the weekend", async () => {
  const { call, close } = await start();
  // Thu 2026-07-23 to Tue 2026-07-28: Thu, Fri, Mon, Tue.
  const r = await call("/api/entries", { method: "POST", body: { date: "2026-07-23", endDate: "2026-07-28", hours: 8, type: "PTO/FTO", reason: "Shambhala" } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.entries.map((e) => e.date), ["2026-07-23", "2026-07-24", "2026-07-27", "2026-07-28"]);
  const y = await call("/api/entries?year=2026");
  assert.equal(y.body.entries.length, 4);
  assert.equal(y.body.expectedDays, 24);
  close();
});

test("a range skips weekends, holidays and days already logged", async () => {
  const { call, close } = await start();
  // Set up December 2026 as it is in the sheet.
  for (const [date, type, reason, hours] of [
    ["2026-12-24", "Holiday", "Christmas Eve", ""],
    ["2026-12-25", "Holiday", "Christmas Day", ""],
    ["2026-12-28", "PTO/FTO", "", 8],
    ["2026-12-29", "PTO/FTO", "", 8],
  ]) await call("/api/entries", { method: "POST", body: { date, type, reason, hours } });

  // Dec 22 (Tue) to Dec 30 (Wed).
  const plan = await call("/api/entries/plan?date=2026-12-22&endDate=2026-12-30");
  assert.deepEqual(plan.body.add, ["2026-12-22", "2026-12-23", "2026-12-30"]);
  assert.deepEqual(plan.body.skipped.map((s) => `${s.date} ${s.why}`), [
    "2026-12-24 holiday",
    "2026-12-25 holiday",
    "2026-12-26 weekend",
    "2026-12-27 weekend",
    "2026-12-28 logged",
    "2026-12-29 logged",
  ]);
  assert.equal(plan.body.skipped[0].label, "Christmas Eve");

  const r = await call("/api/entries", { method: "POST", body: { date: "2026-12-22", endDate: "2026-12-30", hours: 8, type: "PTO/FTO", reason: "Christmas break" } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.entries.map((e) => e.date), ["2026-12-22", "2026-12-23", "2026-12-30"]);
  assert.equal(r.body.skipped.length, 6);

  // Asking again adds nothing: every day is now taken.
  const again = await call("/api/entries", { method: "POST", body: { date: "2026-12-22", endDate: "2026-12-30", hours: 8, type: "PTO/FTO" } });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already logged/);
  close();
});

test("marks an entry reported and back", async () => {
  const { call, close } = await start();
  const { body } = await call("/api/entries", { method: "POST", body: { date: "2026-12-28", hours: 8, type: "PTO/FTO" } });
  const id = body.entries[0].id;
  assert.equal(body.entries[0].reported, false);
  let r = await call(`/api/entries/${id}`, { method: "PATCH", body: { reported: true } });
  assert.equal(r.body.reported, true);
  assert.ok(r.body.reportedAt);
  r = await call(`/api/entries/${id}`, { method: "PATCH", body: { reported: false } });
  assert.equal(r.body.reported, false);
  assert.equal(r.body.reportedAt, null);
  close();
});

test("marks several entries reported at once", async () => {
  const { call, close } = await start();
  const { body } = await call("/api/entries", { method: "POST", body: { date: "2026-12-28", endDate: "2026-12-30", hours: 8, type: "PTO/FTO" } });
  const ids = body.entries.map((e) => e.id);
  const r = await call("/api/entries/reported", { method: "POST", body: { ids } });
  assert.equal(r.status, 200);
  assert.ok(r.body.entries.every((e) => e.reported));
  const years = await call("/api/years");
  assert.equal(years.body.years[0].unreported, 0);
  close();
});

test("a company holiday with no hours does not need reporting", async () => {
  const { call, close } = await start();
  const { body } = await call("/api/entries", { method: "POST", body: { date: "2026-12-25", hours: "", type: "Holiday", reason: "Christmas Day" } });
  assert.equal(body.entries[0].needsReport, false);
  const years = await call("/api/years");
  assert.equal(years.body.years[0].unreported, 0);
  close();
});

test("rejects bad input with a message that says what to fix", async () => {
  const { call, close } = await start();
  let r = await call("/api/entries", { method: "POST", body: { date: "2026-02-30", hours: 8, type: "PTO/FTO" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /real date/);
  r = await call("/api/entries", { method: "POST", body: { date: "2026-02-03", hours: 30, type: "PTO/FTO" } });
  assert.match(r.body.error, /between 0 and 24/);
  r = await call("/api/entries", { method: "POST", body: { date: "2026-02-03", hours: 8, type: "Vacation" } });
  assert.match(r.body.error, /Type must be one of/);
  close();
});

test("exports CSV and serves the page for app routes", async () => {
  const { call, close } = await start();
  await call("/api/entries", { method: "POST", body: { date: "2026-05-22", hours: 8, type: "PTO/FTO", reason: "California, with \"quotes\"" } });
  const csv = await call("/api/export.csv");
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.body, /2026-05-22,8,PTO\/FTO,"California, with ""quotes""",no,/);
  await call("/api/entries", { method: "POST", body: { date: "2025-12-01", hours: 8, type: "PTO/FTO", reason: "Beach Trip" } });
  const one = await call("/api/export.csv?year=2025");
  assert.match(one.headers.get("content-disposition"), /time-off-2025\.csv/);
  assert.equal(one.body.trim().split("\n").length, 2);
  assert.match(one.body, /2025-12-01/);
  assert.doesNotMatch(one.body, /2026-05-22/);
  assert.equal((await call("/api/export.csv?year=abc")).status, 400);
  const page = await call("/2025");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Time off<\/title>/);
  assert.equal((await call("/nope.js")).status, 404);
  close();
});
