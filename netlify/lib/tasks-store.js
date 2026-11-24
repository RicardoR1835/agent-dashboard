// netlify/lib/tasks-store.js
// Everything that reads or writes the Tasks tab, shared by tasks.js (the hub) and promo.js
// (the Promote button). Tasks are always found by Task ID, never by row number.
//
// Optional columns the code uses when they exist in row 1 of the Tasks tab:
//   Waiting on     who or what a task is blocked on (shown as a chip)
//   Requested by   who asked for the work; emailed when it's Published and when it's Closed

const { teamMembers } = require("./auth");
const { readTab, writeRow, appendRow, appendRows } = require("./google");
const { emailReady, sendEmail } = require("./email");

const STATUSES = ["Backlog", "To do", "In progress", "Needs review", "Changes requested", "Scheduled", "Published", "Closed"];
const TYPES = ["CONTENT", "PROMO", "EMAIL", "SOCIAL", "SEO", "PAID", "OPS", "DESIGN", "WEB"];
const PRIORITIES = ["High", "Normal", "Low"];
const RESULTS = ["Used as-is", "Light edit", "Rewrote", "Didn't use"];
const PROMOTABLE = ["CONTENT", "SOCIAL", "EMAIL", "PROMO"];

// Sheet header (any order, case doesn't matter) -> field name
const COLUMNS = {
  "task id": "taskId",
  created: "created",
  client: "client",
  title: "title",
  type: "type",
  status: "status",
  "status since": "statusSince",
  owner: "owner",
  reviewer: "reviewer",
  priority: "priority",
  due: "due",
  brief: "brief",
  "content link": "contentLink",
  "published link": "publishedLink",
  output: "output",
  result: "result",
  "waiting on": "waitingOn",
  "requested by": "requestedBy",
  "parent task": "parentTask",
  "updated by": "updatedBy",
  "updated at": "updatedAt",
};
const REQUIRED = ["task id", "client", "title", "type", "status", "owner"];
const DATE_FIELDS = new Set(["created", "statusSince", "due"]);
const EDITABLE = ["client", "title", "type", "status", "owner", "reviewer", "priority", "due", "brief", "contentLink", "publishedLink", "output", "result", "waitingOn", "requestedBy", "parentTask"];
const TAB = () => process.env.TASKS_TAB || "Tasks";

const pad = (n) => String(n).padStart(2, "0");

// Sheets serial number (days since 1899-12-30) -> "YYYY-MM-DD" or full ISO time
function fromSerial(n, withTime) {
  const d = new Date(Math.round((n - 25569) * 86400000));
  if (withTime) return d.toISOString();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function toDate(v, withTime) {
  if (v === "" || v === null || v === undefined) return "";
  // A whole number is a date with no time, so keep it as a plain date (no time zone shift)
  if (typeof v === "number") return fromSerial(v, withTime && !Number.isInteger(v));
  const s = String(v).trim();
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s; // leave odd text alone so nobody's note disappears
  const d = new Date(t);
  if (withTime && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return d.toISOString();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const canonical = (list, v) => list.find((x) => x.toLowerCase() === String(v ?? "").trim().toLowerCase());
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// ---------- reading ----------

function readLayout(header) {
  const keys = header.map((h) => COLUMNS[String(h).trim().toLowerCase()] || null);
  const present = new Set(header.map((h) => String(h).trim().toLowerCase()));
  const missing = REQUIRED.filter((c) => !present.has(c));
  if (missing.length) {
    const nice = missing.map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase())).join(", ");
    throw new Error(`The Tasks tab is missing these column headers in row 1: ${nice}.`);
  }
  return keys;
}

function parseLine(keys, line, rowNumber) {
  const t = {};
  keys.forEach((k, col) => {
    if (!k) return;
    const raw = line[col] ?? "";
    if (k === "updatedAt") t[k] = toDate(raw, true);
    else if (DATE_FIELDS.has(k)) t[k] = toDate(raw, false);
    else t[k] = String(raw).trim();
  });
  t.row = rowNumber;
  return t;
}

function tidy(t, warnings) {
  const status = canonical(STATUSES, t.status);
  if (!status && warnings) warnings.push(`${t.taskId} has status "${t.status}", which isn't one of the eight. It's shown under Backlog.`);
  t.status = status || "Backlog";
  const type = canonical(TYPES, t.type);
  if (t.type && !type && warnings) warnings.push(`${t.taskId} has type "${t.type}", which the hub doesn't know.`);
  t.type = type || String(t.type || "").toUpperCase();
  t.priority = canonical(PRIORITIES, t.priority) || (t.priority ? t.priority : "Normal");
  return t;
}

async function loadAll() {
  const { header, rows } = await readTab(TAB());
  const keys = readLayout(header);
  const tasks = [];
  const warnings = [];
  const seen = new Set();
  rows.forEach((line, i) => {
    const t = parseLine(keys, line, i + 2);
    if (!t.title && !t.taskId) return;
    if (!t.taskId) {
      warnings.push(`Row ${t.row} ("${t.title}") has no Task ID, so it's hidden. Give it one like T-0042.`);
      return;
    }
    if (seen.has(t.taskId)) {
      warnings.push(`Task ID ${t.taskId} is used more than once (row ${t.row}). Only the first one is shown.`);
      return;
    }
    seen.add(t.taskId);
    tasks.push(tidy(t, warnings));
  });
  return { header, keys, rows, tasks, warnings };
}

// ---------- writing ----------

function lineFor(keys, base, task) {
  const line = keys.map((_, i) => (base && base[i] !== undefined ? base[i] : ""));
  keys.forEach((k, i) => {
    if (k && task[k] !== undefined) line[i] = task[k];
  });
  return line;
}

function cleanValue(k, v) {
  const s = String(v ?? "").trim();
  if (k === "status") return canonical(STATUSES, s) || s;
  if (k === "type") return canonical(TYPES, s) || s.toUpperCase();
  if (k === "priority") return canonical(PRIORITIES, s) || s;
  if (k === "due") return s ? toDate(s, false) : "";
  return s.slice(0, 5000);
}

// Returns an error message, or "" when the task is fine to save.
function problem(t) {
  if (!t.title) return "Give the task a title.";
  if (!t.client) return "Pick a client.";
  if (!canonical(TYPES, t.type)) return "Pick a task type.";
  if (!canonical(STATUSES, t.status)) return "Pick a status.";
  if (t.status !== "Backlog" && !t.owner) return "Pick an owner. Only Backlog tasks can be unassigned.";
  if (t.status === "Needs review" && !t.reviewer) return "Pick a reviewer before sending this for review.";
  if (t.status === "Published" && !/^https?:\/\//i.test(t.publishedLink || "")) return "Add the published link (starting with https://) before marking this Published.";
  if (t.status === "Closed" && !t.result) return "Fill in the Result before closing the task.";
  if (t.due && !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) return "Use a real date for Due.";
  return "";
}

// ---------- handoff emails ----------

function emailFor(name) {
  const m = teamMembers().find((x) => same(x.name, name));
  return m ? m.email : "";
}

function taskLink(id) {
  const base = (process.env.URL || "https://occdash.netlify.app").replace(/\/$/, "");
  return `${base}/tasks.html#${encodeURIComponent(id)}`;
}

// Decides who should hear about a change. Never emails the person who made it.
function handoffs(before, after, by) {
  const out = [];
  const add = (name, reason, intro) => {
    if (name && !same(name, by) && !out.some((o) => same(o.name, name))) out.push({ name, reason, intro });
  };
  const statusChanged = !before || before.status !== after.status;
  const reviewerChanged = before && !same(before.reviewer, after.reviewer);
  if (after.status === "Needs review" && (statusChanged || reviewerChanged)) add(after.reviewer, "review", `${by} sent this to you for review.`);
  if (statusChanged && after.status === "Changes requested") add(after.owner, "changes", `${by} requested changes on this task.`);
  if ((!before && after.owner) || (before && !same(before.owner, after.owner))) add(after.owner, "owner", `${by} assigned this task to you.`);
  // The person who asked for the work hears when it goes out and when it's closed
  if (before && statusChanged && after.status === "Published") add(after.requestedBy, "published", `${by} marked this Published.`);
  if (before && statusChanged && after.status === "Closed") add(after.requestedBy, "closed", `${by} closed this task. Result: ${after.result || "none noted"}.`);
  return out;
}

const SUBJECTS = { review: "To review", changes: "Changes requested", owner: "Assigned to you", published: "Published", closed: "Closed" };

async function sendHandoffs(list, task) {
  const emailed = [];
  const warnings = [];
  if (!list.length) return { emailed, warnings };
  if (!emailReady()) {
    warnings.push("Handoff emails aren't set up (RESEND_API_KEY and PROMO_FROM are needed), so nobody was emailed.");
    return { emailed, warnings };
  }
  for (const h of list) {
    const to = emailFor(h.name);
    if (!to) {
      warnings.push(`${h.name} has no @overcoffeeconsulting.com address in TEAM_MEMBERS, so they weren't emailed.`);
      continue;
    }
    try {
      await sendEmail({
        to,
        subject: `${SUBJECTS[h.reason] || "Task update"}: ${task.title} (${task.client})`.slice(0, 180),
        intro: h.intro,
        lines: [
          ["Task", `${task.taskId} ${task.title}`],
          ["Client", task.client],
          ["Status", task.status],
          ["Due", task.due],
          ["Published link", h.reason === "published" ? task.publishedLink : ""],
          ["Brief", String(task.brief || "").slice(0, 400)],
        ],
        link: taskLink(task.taskId),
      });
      emailed.push(h.name);
    } catch (err) {
      warnings.push(`Email to ${h.name} didn't send: ${err.message}`);
    }
  }
  return { emailed, warnings };
}

// ---------- actions ----------
// Each returns { code, ...payload } where code is the HTTP status the hub should see.

async function createTask(input, by, { notify = true } = {}) {
  by = String(by || "").trim() || "Someone";
  const { keys, rows, tasks } = await loadAll();
  const idCol = keys.indexOf("taskId");
  const max = Math.max(0, ...tasks.map((t) => parseInt(String(t.taskId).replace(/\D/g, ""), 10) || 0), ...rows.map((r) => parseInt(String(r[idCol] || "").replace(/\D/g, ""), 10) || 0));
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const t = { taskId: `T-${String(max + 1).padStart(4, "0")}`, created: today, statusSince: today, updatedBy: by, updatedAt: now };
  for (const k of EDITABLE) t[k] = cleanValue(k, (input || {})[k]);
  t.status = t.status || (t.owner ? "To do" : "Backlog");
  t.priority = t.priority || "Normal";
  if (!t.requestedBy) t.requestedBy = by;
  for (const k of ["waitingOn", "requestedBy"]) if (!keys.includes(k)) t[k] = "";

  const err = problem(t);
  if (err) return { code: 400, error: err };

  await appendRow(TAB(), lineFor(keys, null, t));
  const task = tidy({ ...t, row: rows.length + 2 });
  const mail = notify ? await sendHandoffs(handoffs(null, task, by), task) : { emailed: [], warnings: [] };
  return { code: 200, task, ...mail };
}

// Several tasks at once (one sheet read, one write), with consecutive Task IDs. No emails.
async function createMany(inputs, by) {
  by = String(by || "").trim() || "Someone";
  const { keys, rows, tasks } = await loadAll();
  const idCol = keys.indexOf("taskId");
  let max = Math.max(0, ...tasks.map((t) => parseInt(String(t.taskId).replace(/\D/g, ""), 10) || 0), ...rows.map((r) => parseInt(String(r[idCol] || "").replace(/\D/g, ""), 10) || 0));
  const now = new Date().toISOString();
  const made = [];
  for (const input of inputs) {
    const t = { taskId: `T-${String(++max).padStart(4, "0")}`, created: now.slice(0, 10), statusSince: now.slice(0, 10), updatedBy: by, updatedAt: now };
    for (const k of EDITABLE) t[k] = cleanValue(k, (input || {})[k]);
    t.status = t.status || "Backlog";
    t.priority = t.priority || "Normal";
    if (!t.requestedBy) t.requestedBy = by;
    for (const k of ["waitingOn", "requestedBy"]) if (!keys.includes(k)) t[k] = "";
    const err = problem(t);
    if (err) return { code: 400, error: `"${t.title || "Untitled"}": ${err}` };
    made.push(t);
  }
  if (!made.length) return { code: 400, error: "Nothing to add." };
  await appendRows(TAB(), made.map((t) => lineFor(keys, null, t)));
  return { code: 200, tasks: made.map((t, i) => tidy({ ...t, row: rows.length + 2 + i })) };
}

// force: skip the "someone else saved it" check (used by tools that change only their own fields)
async function updateTask(taskId, changes, by, { expectedUpdatedAt = "", force = false, notify = true } = {}) {
  by = String(by || "").trim() || "Someone";
  const { keys, rows, tasks } = await loadAll();
  const current = tasks.find((t) => t.taskId === taskId);
  if (!current) return { code: 404, error: `Task ${taskId} isn't in the sheet anymore. Refresh the hub.` };

  if (!force && (expectedUpdatedAt || "") !== (current.updatedAt || "")) {
    return {
      code: 409,
      error: `${current.updatedBy || "Someone"} changed this task while you had it open. Their version is shown now; make your change again.`,
      current,
    };
  }

  changes = changes || {};
  for (const [k, label] of [["waitingOn", "Waiting on"], ["requestedBy", "Requested by"]]) {
    if (changes[k] !== undefined && changes[k] !== "" && !keys.includes(k)) {
      return { code: 400, error: `Add a column called "${label}" to the Tasks tab first.`, current };
    }
  }
  const next = { ...current };
  for (const k of EDITABLE) if (changes[k] !== undefined && (keys.includes(k))) next[k] = cleanValue(k, changes[k]);
  if (next.status !== current.status) next.statusSince = new Date().toISOString().slice(0, 10);
  next.updatedBy = by;
  next.updatedAt = new Date().toISOString();

  const err = problem(next);
  if (err) return { code: 400, error: err, current };

  await writeRow(TAB(), current.row, lineFor(keys, rows[current.row - 2], next));
  const task = tidy(next);
  const mail = notify ? await sendHandoffs(handoffs(current, task, by), task) : { emailed: [], warnings: [] };
  return { code: 200, task, ...mail };
}

module.exports = {
  STATUSES, TYPES, PRIORITIES, RESULTS, PROMOTABLE,
  loadAll, createTask, createMany, updateTask, taskLink, same,
};
