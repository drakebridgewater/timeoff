import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb, isIsoDate } from "./db.js";

const ROOT = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const MAX_BODY = 64 * 1024;
const MAX_RANGE_DAYS = 62;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://*.bridgewater.digital",
  // The apps launcher in the header reads the family hub's app list.
  "connect-src 'self' https://social.bridgewater.digital",
  "manifest-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, {
    "content-type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not JSON");
  }
}

// Checks the fields of an entry. With partial, only the fields present are checked.
function cleanEntry(body, { partial = false, types } = {}) {
  const out = {};
  if (!partial || "date" in body) {
    if (!isIsoDate(body.date)) throw new HttpError(400, "Date must be a real date, as YYYY-MM-DD");
    out.date = body.date;
  }
  if (!partial || "hours" in body) {
    const h = body.hours === "" || body.hours == null ? 0 : Number(body.hours);
    if (!Number.isFinite(h) || h < 0 || h > 24) throw new HttpError(400, "Hours must be between 0 and 24");
    out.hours = Math.round(h * 100) / 100;
  }
  if (!partial || "type" in body) {
    const t = String(body.type ?? "").trim().slice(0, 40);
    if (t && types && !types.includes(t)) throw new HttpError(400, `Type must be one of: ${types.join(", ")}`);
    out.type = t;
  }
  if (!partial || "reason" in body) out.reason = String(body.reason ?? "").trim().slice(0, 200);
  if (!partial || "reported" in body) out.reported = !!body.reported;
  return out;
}

// Which days a range adds, and which it skips and why: weekends, days with a
// Holiday entry, and days already logged. A single day is always added as asked.
function planRange(db, start, end) {
  if (!isIsoDate(start)) throw new HttpError(400, "First day must be a real date, as YYYY-MM-DD");
  if (!end || end === start) return { add: [start], skipped: [] };
  if (!isIsoDate(end)) throw new HttpError(400, "Last day must be a real date, as YYYY-MM-DD");
  if (end < start) throw new HttpError(400, "Last day must be on or after the first day");
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  if ((stop - d) / 86400000 > MAX_RANGE_DAYS) throw new HttpError(400, `Add at most ${MAX_RANGE_DAYS} days at once`);
  const logged = new Map();
  for (const e of db.between(start, end)) {
    // A Holiday entry wins over any other entry on the same day.
    if (!logged.has(e.date) || e.type === "Holiday") logged.set(e.date, e);
  }
  const add = [];
  const skipped = [];
  for (; d <= stop; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    const e = logged.get(date);
    if (wd === 0 || wd === 6) skipped.push({ date, why: "weekend" });
    else if (e && e.type === "Holiday") skipped.push({ date, why: "holiday", label: e.reason || "Holiday" });
    else if (e) skipped.push({ date, why: "logged", label: [e.type, e.reason].filter(Boolean).join(", ") });
    else add.push(date);
  }
  return { add, skipped };
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function createApp({ dbFile = ":memory:", trustUserHeader = true, version = "dev", authUrl = "https://auth.bridgewater.digital" } = {}) {
  const db = openDb(dbFile);

  async function api(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const m = req.method;
    const id = parts[0] === "entries" && /^\d+$/.test(parts[1] || "") ? Number(parts[1]) : null;

    if (parts[0] === "me" && m === "GET") {
      // Authelia, in front of the app, sets these on every request it lets through.
      const header = (h) => (trustUserHeader ? String(req.headers[h] || "").slice(0, 120) || null : null);
      return send(res, 200, { user: header("remote-user"), name: header("remote-name"), email: header("remote-email"), authUrl, version });
    }

    if (parts[0] === "years" && m === "GET") {
      return send(res, 200, { years: db.summary(), ...db.getSettings() });
    }

    if (parts[0] === "entries" && parts.length === 1) {
      if (m === "GET") {
        const year = Number(url.searchParams.get("year"));
        if (!Number.isInteger(year) || year < 1970 || year > 2200) throw new HttpError(400, "Give a year, like ?year=2026");
        return send(res, 200, { year, entries: db.listYear(year), ...db.getSettings() });
      }
      if (m === "POST") {
        const body = await readJson(req);
        const base = cleanEntry(body, { types: db.getSettings().types });
        const { add, skipped } = planRange(db, base.date, body.endDate || null);
        if (!add.length) throw new HttpError(400, "Every day in that range is a weekend, a holiday or already logged");
        const created = db.insertMany(add.map((date) => ({ ...base, date })));
        return send(res, 201, { entries: created, skipped });
      }
    }

    if (parts[0] === "entries" && parts[1] === "plan" && m === "GET") {
      return send(res, 200, planRange(db, url.searchParams.get("date"), url.searchParams.get("endDate") || null));
    }

    if (parts[0] === "entries" && parts[1] === "reported" && m === "POST") {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter(Number.isInteger).slice(0, 500) : [];
      if (!ids.length) throw new HttpError(400, "Give the ids to mark reported");
      return send(res, 200, { entries: db.markReported(ids) });
    }

    if (id !== null && parts.length === 2) {
      if (m === "GET") {
        const e = db.get(id);
        return e ? send(res, 200, e) : send(res, 404, { error: "No such entry" });
      }
      if (m === "PATCH") {
        const body = await readJson(req);
        const e = db.update(id, cleanEntry(body, { partial: true, types: db.getSettings().types }));
        return e ? send(res, 200, e) : send(res, 404, { error: "No such entry" });
      }
      if (m === "DELETE") return db.remove(id) ? send(res, 204, "") : send(res, 404, { error: "No such entry" });
    }

    if (parts[0] === "settings") {
      if (m === "GET") return send(res, 200, db.getSettings());
      if (m === "PUT") {
        const body = await readJson(req);
        const s = {};
        if ("expectedDays" in body) {
          const n = Number(body.expectedDays);
          if (!Number.isFinite(n) || n < 0 || n > 366) throw new HttpError(400, "Expected days must be between 0 and 366");
          s.expectedDays = n;
        }
        if ("types" in body) {
          const list = Array.isArray(body.types) ? body.types : String(body.types || "").split("\n");
          const types = [...new Set(list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))];
          if (!types.length) throw new HttpError(400, "Keep at least one type");
          s.types = types;
        }
        return send(res, 200, db.saveSettings(s));
      }
    }

    // Every day ever logged, or one year with ?year=2026.
    if (parts[0] === "export.csv" && m === "GET") {
      const yearParam = url.searchParams.get("year");
      const year = yearParam ? Number(yearParam) : null;
      if (yearParam && (!Number.isInteger(year) || year < 1970 || year > 2200)) throw new HttpError(400, "Give a year, like ?year=2026");
      const list = year ? db.listYear(year) : db.all();
      const lines = [["date", "hours", "type", "reason", "reported", "reported_at"].join(",")];
      for (const e of list) lines.push([e.date, e.hours, e.type, e.reason, e.reported ? "yes" : "no", e.reportedAt || ""].map(csvCell).join(","));
      const name = year ? `time-off-${year}.csv` : `time-off-${new Date().toISOString().slice(0, 10)}.csv`;
      return send(res, 200, lines.join("\n") + "\n", {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
      });
    }

    throw new HttpError(404, "Not found");
  }

  async function serveStatic(res, pathname) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let file = resolve(join(ROOT, rel));
    if (!file.startsWith(ROOT)) throw new HttpError(404, "Not found");
    let s = await stat(file).catch(() => null);
    // Paths that are not files are app routes: hand them the page.
    if (!s || s.isDirectory()) {
      if (extname(rel)) throw new HttpError(404, "Not found");
      file = join(ROOT, "index.html");
      s = await stat(file);
    }
    const ext = extname(file);
    const immutable = rel.startsWith("brand/fonts/");
    res.writeHead(200, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "content-length": s.size,
      // Files are tiny and the image has no build step to fingerprint them, so revalidate everything but fonts.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "last-modified": s.mtime.toUTCString(),
    });
    res.end(await readFile(file));
  }

  const handler = async (req, res) => {
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, "ok");
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong" : err.message });
      else res.end();
    }
  };

  return { handler, db };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const app = createApp({
    dbFile: process.env.DB_FILE || "data/timeoff.sqlite",
    trustUserHeader: process.env.TRUST_USER_HEADER !== "false",
    version: process.env.APP_VERSION || "dev",
    authUrl: process.env.AUTH_URL || "https://auth.bridgewater.digital",
  });
  const server = createServer(app.handler);
  server.listen(port, host, () => console.log(`Time off on http://${host}:${port}`));
  // Sablier and docker stop send SIGTERM: close the database cleanly so the WAL is checkpointed.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      server.close();
      app.db.close();
      process.exit(0);
    });
  }
}
