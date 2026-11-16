// Time off: one page per year of days off, each with a "reported to employer" box,
// plus a years overview and settings. Routes: /, /<year>, /years, /settings.

const B = window.Bridgewater;
const HOURS_PER_DAY = 8;
const $ = (s, el = document) => el.querySelector(s);

/* ---------- small DOM helper ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const mono = (text, cls = "") => h("span", { class: `bw-mono ${cls}`.trim() }, text);

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    ...opts,
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server said ${res.status}`);
  return data;
}

/* ---------- formatting ---------- */
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const asDate = (iso) => new Date(`${iso}T00:00:00`);
const fmtDay = (iso) => asDate(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtShort = (iso) => asDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const monthName = (iso) => asDate(iso).toLocaleDateString("en-US", { month: "long" });
const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
const days = (hours) => num(hours / HOURS_PER_DAY);
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const listJoin = (items) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.dataset.error = isError ? "" : null;
  if (!isError) delete t.dataset.error;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2500);
}

/* ---------- state and routing ---------- */
const state = { me: null, settings: { expectedDays: 24, types: [] }, year: null, entries: [], years: null };

function parseRoute(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return { view: "year", year: new Date().getFullYear(), home: true };
  if (/^\/\d{4}$/.test(p)) return { view: "year", year: Number(p.slice(1)) };
  if (p === "/years") return { view: "years" };
  if (p === "/settings") return { view: "settings" };
  return { view: "missing" };
}

function go(href, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", href);
  route();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || a.hasAttribute("download") || a.target) return;
  e.preventDefault();
  if (url.pathname !== location.pathname) go(url.pathname);
});
window.addEventListener("popstate", () => route());

/* ---------- shell ---------- */
function renderHeader(r) {
  const thisYear = new Date().getFullYear();
  const nav = [
    { label: String(thisYear), href: "/", current: r.view === "year" && r.year === thisYear },
    { label: "Years", href: "/years", current: r.view === "years" || (r.view === "year" && r.year !== thisYear) },
    { label: "Settings", href: "/settings", current: r.view === "settings" },
  ];
  const me = state.me || {};
  const props = { nav, user: me.user || "nobody" };
  if (me.user) {
    props.account = {
      label: (me.name || me.user).split(" ")[0],
      name: me.name || me.user,
      detail: me.email || me.user,
      items: [{ label: "Sign out", href: `${me.authUrl}/logout?rd=${encodeURIComponent(location.origin + "/")}` }],
    };
  }
  $("#hdr").replaceChildren(B.Header(props));
}

function pageHead(title, meta, actions = []) {
  return h(
    "div",
    { class: "bw-pagehead" },
    h("div", { class: "bw-pagehead__text" }, h("h1", null, title), meta && h("p", { class: "bw-pagehead__meta" }, meta)),
    actions.length ? h("div", { class: "bw-pagehead__actions" }, actions) : null,
  );
}

async function route() {
  const r = parseRoute(location.pathname);
  renderHeader(r);
  document.title = r.view === "year" ? `${r.year} · Time off` : r.view === "years" ? "Years · Time off" : r.view === "settings" ? "Settings · Time off" : "Time off";
  const view = $("#view");
  try {
    if (r.view === "year") {
      const data = await api(`entries?year=${r.year}`);
      state.year = r.year;
      state.entries = data.entries;
      state.settings = { expectedDays: data.expectedDays, types: data.types };
      renderYear();
    } else if (r.view === "years") {
      const data = await api("years");
      state.years = data.years;
      state.settings = { expectedDays: data.expectedDays, types: data.types };
      renderYears();
    } else if (r.view === "settings") {
      state.settings = await api("settings");
      renderSettings();
    } else {
      view.replaceChildren(
        h("div", { class: "bw-focus" }, h("h1", null, "Not here"), h("p", { class: "bw-focus__lede" }, "There is no page at ", mono(location.pathname), "."), h("div", { class: "bw-focus__actions" }, B.Button({ label: "Go to this year", variant: "primary", href: "/" }))),
      );
    }
  } catch (err) {
    view.replaceChildren(h("div", { class: "bw-focus" }, h("h1", null, "Could not load"), h("p", { class: "bw-focus__lede" }, err.message), h("div", { class: "bw-focus__actions" }, B.Button({ label: "Try again", variant: "primary", onClick: () => route() }))));
  }
}

/* ---------- year page ---------- */
const open = (list) => list.filter((e) => e.needsReport && !e.reported);

function yearMeta() {
  const list = state.entries;
  const hours = list.reduce((s, e) => s + e.hours, 0);
  const expected = state.settings.expectedDays;
  const used = hours / HOURS_PER_DAY;
  const left = expected - used;
  const unreported = open(list);
  const meta = [
    mono(`${num(used)} of ${num(expected)} days`),
    " · ",
    mono(plural(hours, "hour")),
    " · ",
    left >= 0 ? `${plural(left, "day")} left` : h("span", { class: "over" }, `${plural(-left, "day")} over`),
  ];
  if (unreported.length) meta.push(" · ", h("span", { class: "attn" }, `${unreported.length} not reported`));
  return meta;
}

// The one panel: what is not reported yet. Once a panel has been shown, it stays
// (as "all reported") until the page is redrawn, so ticking boxes never shifts the page.
function yearPanel(keep) {
  const unreported = open(state.entries);
  if (!unreported.length) {
    return keep ? B.Panel({ role: "green", title: "All reported" }, h("p", null, `Every day in ${state.year} that needs it is reported to your employer.`)) : null;
  }
  const dates = unreported.map((e) => fmtShort(e.date));
  return B.Panel({ role: "amber", title: "Not reported yet" }, [
    h("p", null, `${unreported.length === 1 ? "One day is" : `${unreported.length} days are`} not reported to your employer: ${listJoin(dates)}.`),
    h("div", { class: "panel-actions" }, B.Button({ label: unreported.length === 1 ? "Mark reported" : "Mark all reported", variant: "secondary", onClick: () => markAll(unreported) })),
  ]);
}

// Redraws the counts and the panel in place, after a box is ticked.
function refreshYearSummary() {
  $(".bw-pagehead__meta").replaceChildren(...yearMeta());
  const slot = $("#panel-slot");
  slot.replaceChildren(yearPanel(slot.childElementCount > 0) || "");
}

function renderYear() {
  const year = state.year;
  const list = state.entries;
  const actions = [
    B.Button({ label: String(year - 1), variant: "secondary", href: year - 1 === new Date().getFullYear() ? "/" : `/${year - 1}`, ariaLabel: `Previous year, ${year - 1}` }),
    B.Button({ label: String(year + 1), variant: "secondary", href: year + 1 === new Date().getFullYear() ? "/" : `/${year + 1}`, ariaLabel: `Next year, ${year + 1}` }),
    B.Button({ label: "Add time off", variant: "primary", onClick: () => entryDialog() }),
  ];
  const panel = yearPanel(false);
  // The page head holds three actions at most, so Export sits on the right of the list's own head.
  const listHead = h(
    "div",
    { class: "bw-section__head list-head" },
    h("h2", null, "Days"),
    list.length ? B.Button({ label: `Export ${year}`, variant: "secondary", size: "sm", href: `/api/export.csv?year=${year}`, ariaLabel: `Export ${year} as CSV` }) : null,
  );
  $("#view").replaceChildren(
    pageHead(String(year), yearMeta(), actions),
    h("div", { id: "panel-slot" }, panel),
    h("section", { class: "bw-section" }, listHead, list.length ? entryTable(list) : h("p", { class: "empty bw-soft" }, `Nothing logged for ${year} yet.`)),
  );
}

function entryTable(list) {
  const today = todayIso();
  const body = h("tbody");
  let month = null;
  let todayMarked = state.year !== new Date().getFullYear();
  for (const e of list) {
    const m = e.date.slice(0, 7);
    if (m !== month) {
      month = m;
      const monthHours = list.filter((x) => x.date.startsWith(m)).reduce((s, x) => s + x.hours, 0);
      body.append(
        h("tr", { class: "month" }, h("th", { colspan: "6", scope: "rowgroup" }, h("span", { class: "month__name" }, monthName(e.date)), monthHours ? h("span", { class: "bw-count" }, plural(monthHours, "hour")) : null)),
      );
    }
    if (!todayMarked && e.date >= today) {
      todayMarked = true;
      body.append(h("tr", { class: "today" }, h("td", { colspan: "6" }, mono(`today, ${fmtShort(today)}`, "bw-comment"))));
    }
    body.append(entryRow(e));
  }
  return h(
    "table",
    { class: "entries" },
    h("thead", null, h("tr", null, h("th", { scope: "col" }, "Date"), h("th", { scope: "col", class: "num" }, "Hours"), h("th", { scope: "col" }, "Type"), h("th", { scope: "col" }, "Reason"), h("th", { scope: "col" }, "Reported"), h("th", { scope: "col" }, h("span", { class: "sr" }, "Actions")))),
    body,
  );
}

function reportedCell(e) {
  if (!e.needsReport) return h("span", { class: "bw-comment" }, "not needed");
  const id = `rep-${e.id}`;
  const box = h("input", { type: "checkbox", id, checked: e.reported, "aria-label": `Reported to employer, ${fmtDay(e.date)}` });
  box.addEventListener("change", () => setReported(e, box.checked));
  return h("label", { class: "report", for: id }, box, h("span", { class: e.reported ? "report__word" : "report__word attn" }, e.reported ? "reported" : "not reported"));
}

function entryRow(e) {
  return h(
    "tr",
    { "data-id": e.id },
    h("td", { class: "date" }, mono(fmtDay(e.date))),
    h("td", { class: "num hours" }, e.hours || e.needsReport ? mono(num(e.hours)) : h("span", { class: "bw-comment" }, "–")),
    h("td", { class: "type" }, e.type || h("span", { class: "attn" }, "no type")),
    h("td", { class: "reason bw-soft" }, e.reason),
    h("td", { class: "reported" }, reportedCell(e)),
    h("td", { class: "edit" }, B.Button({ label: "Edit", variant: "quiet", size: "sm", ariaLabel: `Edit ${fmtDay(e.date)}`, onClick: () => entryDialog(e) })),
  );
}

// Swaps one row's Reported cell, keeping focus on its box for keyboard users.
function redrawReported(e) {
  const cell = $(`tr[data-id="${e.id}"] td.reported`);
  if (!cell) return;
  const hadFocus = cell.contains(document.activeElement);
  cell.replaceChildren(reportedCell(e));
  if (hadFocus) cell.querySelector("input")?.focus();
}

async function setReported(e, value) {
  const prev = e.reported;
  e.reported = value;
  redrawReported(e);
  refreshYearSummary();
  try {
    Object.assign(e, await api(`entries/${e.id}`, { method: "PATCH", body: { reported: value } }));
    toast(value ? `${fmtShort(e.date)} marked reported` : `${fmtShort(e.date)} marked not reported`);
  } catch (err) {
    e.reported = prev;
    redrawReported(e);
    refreshYearSummary();
    toast(`Not saved. ${err.message}`, true);
  }
}

async function markAll(list) {
  const ok = await B.confirm({
    title: list.length === 1 ? "Mark this day reported?" : `Mark ${list.length} days reported?`,
    message: `${listJoin(list.map((e) => fmtShort(e.date)))}. You can untick any of them later.`,
    confirm: "Mark reported",
    danger: false,
  });
  if (!ok) return;
  try {
    const { entries } = await api("entries/reported", { method: "POST", body: { ids: list.map((e) => e.id) } });
    const byId = new Map(entries.map((e) => [e.id, e]));
    state.entries = state.entries.map((e) => byId.get(e.id) || e);
    for (const e of entries) redrawReported(e);
    refreshYearSummary();
    toast(`${plural(entries.length, "day")} marked reported`);
  } catch (err) {
    toast(`Not saved. ${err.message}`, true);
  }
}

/* ---------- add and edit ---------- */
function dateField(label, value, hint) {
  const f = B.Field({ label, type: "text", value: value || "", mono: true, hint });
  f.control.type = "date";
  return f;
}

function entryDialog(entry) {
  const editing = !!entry;
  const types = state.settings.types.slice();
  if (editing && entry.type && !types.includes(entry.type)) types.push(entry.type);
  const defaultDate = editing ? entry.date : state.year === new Date().getFullYear() ? todayIso() : `${state.year}-01-01`;

  const fDate = dateField(editing ? "Date" : "First day", defaultDate);
  const fEnd = editing ? null : dateField("Last day", "", "Leave empty for one day. Weekends, holidays and days already logged are skipped.");
  const plan = h("div", { class: "plan", "aria-live": "polite", hidden: true });
  const fHours = B.Field({ label: editing ? "Hours" : "Hours per day", type: "number", value: editing ? entry.hours : HOURS_PER_DAY, mono: true });
  fHours.control.min = "0";
  fHours.control.max = "24";
  fHours.control.step = "0.5";
  const fType = B.Field({
    label: "Type",
    type: "select",
    value: editing ? entry.type : types[0],
    options: [...(editing && !entry.type ? [{ value: "", label: "No type" }] : []), ...types],
  });
  const fReason = B.Field({ label: "Reason", type: "text", value: editing ? entry.reason : "" });
  const fReported = B.Field({ label: "Reported to employer", type: "checkbox", checked: editing ? entry.reported : false });
  const err = h("p", { class: "form-error", role: "alert", hidden: true });

  const values = () => ({
    date: fDate.control.value,
    endDate: fEnd ? fEnd.control.value || null : undefined,
    hours: fHours.control.value,
    type: fType.control.value,
    reason: fReason.control.value,
    reported: fReported.control.checked,
  });

  async function save(e) {
    e.preventDefault();
    err.hidden = true;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const v = values();
      if (editing) {
        delete v.endDate;
        await api(`entries/${entry.id}`, { method: "PATCH", body: v });
        toast(`${fmtShort(v.date)} saved`);
      } else {
        const { entries, skipped } = await api("entries", { method: "POST", body: v });
        const added = entries.length === 1 ? `${fmtShort(entries[0].date)} added` : `${entries.length} days added, ${fmtShort(entries[0].date)} to ${fmtShort(entries.at(-1).date)}`;
        toast(skipped.length ? `${added}. ${plural(skipped.length, "day")} skipped.` : added);
      }
      dlg.close("save");
      const y = Number(v.date.slice(0, 4));
      if (y !== state.year) go(y === new Date().getFullYear() ? "/" : `/${y}`);
      else route();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  }

  async function remove(e) {
    e.preventDefault();
    const ok = await B.confirm({
      title: "Delete this day?",
      message: `${fmtDay(entry.date)}, ${plural(entry.hours, "hour")}${entry.type ? ` of ${entry.type}` : ""}. This cannot be undone.`,
      confirm: "Delete day",
    });
    if (!ok) return;
    try {
      await api(`entries/${entry.id}`, { method: "DELETE" });
      dlg.close("delete");
      toast(`${fmtShort(entry.date)} deleted`);
      route();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  }

  const actions = [
    ...(editing ? [{ label: "Delete", value: "delete", variant: "danger", onClick: remove }] : []),
    { label: "Cancel", value: "cancel", variant: "secondary" },
    { label: editing ? "Save" : "Add", value: "save", variant: "primary", onClick: save },
  ];
  const dlg = B.Dialog(
    { title: editing ? `Edit ${fmtShort(entry.date)}` : "Add time off", actions, className: "entry-dialog", onClose: () => dlg.remove() },
    h("div", { class: "bw-stack" }, err, fEnd ? [h("div", { class: "pair" }, fDate, fEnd), plan] : fDate, fHours, fType, fReason, fReported),
  );
  if (fEnd) {
    const addBtn = dlg.querySelector('button[value="save"]');
    let seq = 0;
    // Asks the server which days the range adds and skips, and says so before you click Add.
    async function refreshPlan() {
      const start = fDate.control.value;
      const end = fEnd.control.value;
      fEnd.control.min = start || "";
      const mine = ++seq;
      if (!start || !end || end === start) {
        plan.hidden = true;
        addBtn.textContent = "Add";
        addBtn.disabled = false;
        return;
      }
      try {
        const p = await api(`entries/plan?date=${start}&endDate=${end}`);
        if (mine !== seq) return;
        plan.replaceChildren(...planText(p));
        addBtn.textContent = p.add.length ? `Add ${plural(p.add.length, "day")}` : "Add";
        addBtn.disabled = !p.add.length;
      } catch (ex) {
        if (mine !== seq) return;
        plan.replaceChildren(h("p", { class: "form-error" }, ex.message));
        addBtn.textContent = "Add";
        addBtn.disabled = true;
      }
      plan.hidden = false;
    }
    for (const f of [fDate, fEnd]) for (const ev of ["change", "input"]) f.control.addEventListener(ev, refreshPlan);
  }
  dlg.showModal();
  fDate.control.focus();
}

const SKIP_WHY = { holiday: "holidays", weekend: "weekend", logged: "already logged" };
function planText({ add, skipped }) {
  const out = [];
  if (add.length) out.push(h("p", null, h("span", { class: "plan__label" }, `Adds ${plural(add.length, "day")}: `), listJoin(add.map(fmtDay)), "."));
  else out.push(h("p", { class: "attn" }, "Nothing to add: every day in that range is a weekend, a holiday or already logged."));
  const groups = Object.keys(SKIP_WHY)
    .map((why) => [why, skipped.filter((s) => s.why === why)])
    .filter(([, list]) => list.length);
  if (groups.length) {
    const parts = groups.map(([why, list]) => {
      const days = listJoin(list.map((s) => (why === "holiday" ? `${fmtShort(s.date)} ${s.label}` : fmtShort(s.date))));
      return `${days} (${why === "holiday" && list.length === 1 ? "holiday" : SKIP_WHY[why]})`;
    });
    out.push(h("p", { class: "bw-comment" }, h("span", { class: "plan__label" }, "Skips: "), parts.join("; "), "."));
  }
  return out;
}

/* ---------- years page ---------- */
function renderYears() {
  const years = state.years;
  const expected = state.settings.expectedDays;
  const full = years.filter((y) => y.year < new Date().getFullYear());
  const avg = full.length ? full.reduce((s, y) => s + y.days, 0) / full.length : 0;
  const max = Math.max(expected, ...years.map((y) => y.days));
  const unreported = years.reduce((s, y) => s + y.unreported, 0);

  const meta = [mono(plural(years.length, "year")), " · ", "average ", mono(`${avg.toFixed(1)} days`), " · ", "expected ", mono(`${num(expected)} days`)];
  if (unreported) meta.push(" · ", h("span", { class: "attn" }, `${unreported} not reported`));

  const rows = years.map((y) => {
    const diff = y.days - expected;
    const href = y.year === new Date().getFullYear() ? "/" : `/${y.year}`;
    return h(
      "tr",
      null,
      h("th", { scope: "row" }, y.totalOnly ? mono(String(y.year)) : h("a", { href, class: "bw-mono" }, String(y.year))),
      h("td", { class: "num" }, mono(days(y.hours))),
      h("td", { class: "num hide-phone" }, mono(num(y.hours))),
      h("td", { class: "num" }, mono(diff === 0 ? "0" : `${diff > 0 ? "+" : "−"}${num(Math.abs(diff))}`)),
      h(
        "td",
        { class: "meter-cell hide-phone", "aria-hidden": "true" },
        h("span", { class: "meter" }, h("span", { class: "meter__fill", style: `width:${(y.days / max) * 100}%` }), h("span", { class: "meter__mark", style: `left:${(expected / max) * 100}%` })),
      ),
      h("td", null, y.totalOnly ? h("span", { class: "bw-comment" }, "total only") : y.unreported ? h("span", { class: "attn" }, `${y.unreported} not reported`) : h("span", { class: "bw-comment" }, "all reported")),
    );
  });

  $("#view").replaceChildren(
    pageHead("Years", meta, [B.Button({ label: "Export all", variant: "secondary", href: "/api/export.csv", ariaLabel: "Export every year as CSV" })]),
    h(
      "table",
      { class: "years" },
      h(
        "thead",
        null,
        h("tr", null, h("th", { scope: "col" }, "Year"), h("th", { scope: "col", class: "num" }, "Days"), h("th", { scope: "col", class: "num hide-phone" }, "Hours"), h("th", { scope: "col", class: "num" }, "Against expected"), h("th", { scope: "col", class: "hide-phone" }, h("span", { class: "sr" }, "Days against expected")), h("th", { scope: "col" }, "Reporting")),
      ),
      h("tbody", null, rows),
    ),
    h("p", { class: "note bw-comment" }, "Before 2019 only the yearly total was kept."),
  );
}

/* ---------- settings page ---------- */
function renderSettings() {
  const s = state.settings;
  const fDays = B.Field({ label: "Expected days off", type: "number", value: s.expectedDays, mono: true, hint: "Per year. Each year page counts down from this." });
  fDays.control.min = "0";
  fDays.control.max = "366";
  fDays.control.step = "0.5";
  const fTypes = B.Field({ label: "Types", type: "textarea", value: s.types.join("\n"), rows: 7, hint: "One per line. These fill the Type list when you add a day." });
  const err = h("p", { class: "form-error", role: "alert", hidden: true });

  async function save() {
    err.hidden = true;
    try {
      state.settings = await api("settings", { method: "PUT", body: { expectedDays: fDays.control.value, types: fTypes.control.value } });
      toast("Settings saved");
      renderSettings();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  }

  $("#view").replaceChildren(
    pageHead("Settings"),
    h(
      "form",
      { class: "bw-form", onSubmit: (e) => (e.preventDefault(), save()) },
      err,
      fDays,
      fTypes,
      h("div", { class: "bw-form__actions" }, B.Button({ label: "Cancel", variant: "secondary", onClick: () => renderSettings() }), B.Button({ label: "Save", variant: "primary", type: "submit" })),
    ),
    h(
      "section",
      { class: "bw-section data" },
      h("div", { class: "bw-section__head" }, h("h2", null, "Your data")),
      h("p", { class: "bw-prose bw-soft" }, "Everything is in one SQLite file in the app's ", mono("/data"), " folder. The CSV has every day ever logged, so you can leave any time."),
      h("p", null, B.Button({ label: "Export all", variant: "secondary", href: "/api/export.csv", ariaLabel: "Export every year as CSV" })),
    ),
  );
}

/* ---------- start ---------- */
$("#foot-host").replaceChildren(mono(`${location.host}`));
api("me")
  .then((me) => {
    state.me = me;
    $("#foot-host").replaceChildren(mono(`${location.host} · ${me.version}`));
  })
  .catch(() => {})
  .finally(route);
