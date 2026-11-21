// netlify/functions/tasks.js
// OverCoffee Task Hub: tasks API.
//   GET                                   every task in the Tasks tab, plus the team list
//   POST { action: "create", task, by }   adds a task with the next Task ID
//   POST { action: "update", taskId, changes, expectedUpdatedAt, by }
//                                         changes one task, found by Task ID (never row number).
//                                         If someone else saved it after expectedUpdatedAt,
//                                         nothing is written and their version comes back (409).
// Handoff emails go out when a task gets a new owner, goes to Needs review, or gets
// Changes requested. Only to @overcoffeeconsulting.com addresses listed in TEAM_MEMBERS.
//
// Env vars:
//   TEAM_ACCESS_CODE, TEAM_MEMBERS                             see netlify/lib/auth.js
//   GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, PROMO_SHEET_ID    see netlify/lib/google.js
//   RESEND_API_KEY, PROMO_FROM (or TASKS_FROM)                 see netlify/lib/email.js
//   TASKS_TAB   optional, defaults to "Tasks"

const { checkAccess, teamMembers } = require("../lib/auth");
const { googleReady, readTab, writeRow, appendRow } = require("../lib/google");
const { emailReady, sendEmail } = require("../lib/email");

const STATUSES = ["Backlog", "To do", "In progress", "Needs review", "Changes requested", "Scheduled", "Published", "Closed"];
const TYPES = ["CONTENT", "PROMO", "EMAIL", "SOCIAL", "SEO", "PAID", "OPS", "DESIGN", "WEB"];
const PRIORITIES = ["High", "Normal", "Low"];
const RESULTS = ["Used as-is", "Light edit", "Rewrote", "Didn't use"];

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
  "parent task": "parentTask",
  "updated by": "updatedBy",
  "updated at": "updatedAt",
};
const REQUIRED = ["task id", "client", "title", "type", "status", "owner"];
const DATE_FIELDS = new Set(["created", "statusSince", "due"]);
const EDITABLE = ["client", "title", "type", "status", "owner", "reviewer", "priority", "due", "brief", "contentLink", "publishedLink", "output", "result", "waitingOn", "parentTask"];
const TAB = () => process.env.TASKS_TAB || "Tasks";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

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
  if (statusChanged && after.status === "Needs review") add(after.reviewer, "review", `${by} sent this to you for review.`);
  if (statusChanged && after.status === "Changes requested") add(after.owner, "changes", `${by} requested changes on this task.`);
  if ((!before && after.owner) || (before && !same(before.owner, after.owner))) add(after.owner, "owner", `${by} assigned this task to you.`);
  return out;
}

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
        subject: `${h.reason === "review" ? "To review" : h.reason === "changes" ? "Changes requested" : "Assigned to you"}: ${task.title} (${task.client})`.slice(0, 180),
        intro: h.intro,
        lines: [
          ["Task", `${task.taskId} ${task.title}`],
          ["Client", task.client],
          ["Status", task.status],
          ["Due", task.due],
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

async function create(body) {
  const by = String(body.by || "").trim() || "Someone";
  const input = body.task || {};
  const { keys, rows, tasks } = await loadAll();

  const max = Math.max(0, ...tasks.map((t) => parseInt(String(t.taskId).replace(/\D/g, ""), 10) || 0), ...rows.map((r) => parseInt(String(r[keys.indexOf("taskId")] || "").replace(/\D/g, ""), 10) || 0));
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const t = { taskId: `T-${String(max + 1).padStart(4, "0")}`, created: today, statusSince: today, updatedBy: by, updatedAt: now };
  for (const k of EDITABLE) t[k] = cleanValue(k, input[k]);
  t.status = t.status || (t.owner ? "To do" : "Backlog");
  t.priority = t.priority || "Normal";
  if (t.waitingOn && !keys.includes("waitingOn")) t.waitingOn = "";

  const err = problem(t);
  if (err) return json(400, { error: err });

  await appendRow(TAB(), lineFor(keys, null, t));
  const task = tidy({ ...t, row: rows.length + 2 });
  const mail = await sendHandoffs(handoffs(null, task, by), task);
  return json(200, { task, ...mail });
}

async function update(body) {
  const by = String(body.by || "").trim() || "Someone";
  const { keys, rows, tasks } = await loadAll();
  const current = tasks.find((t) => t.taskId === body.taskId);
  if (!current) return json(404, { error: `Task ${body.taskId} isn't in the sheet anymore. Refresh the hub.` });

  // Someone saved it after this person opened it: don't overwrite, show theirs
  if ((body.expectedUpdatedAt || "") !== (current.updatedAt || "")) {
    return json(409, {
      error: `${current.updatedBy || "Someone"} changed this task while you had it open. Their version is shown now; make your change again.`,
      current,
    });
  }

  const changes = body.changes || {};
  const next = { ...current };
  for (const k of EDITABLE) if (changes[k] !== undefined) next[k] = cleanValue(k, changes[k]);
  if (changes.waitingOn !== undefined && !keys.includes("waitingOn")) {
    return json(400, { error: 'Add a column called "Waiting on" to the Tasks tab first.' });
  }
  if (next.status !== current.status) next.statusSince = new Date().toISOString().slice(0, 10);
  next.updatedBy = by;
  next.updatedAt = new Date().toISOString();

  const err = problem(next);
  if (err) return json(400, { error: err, current });

  await writeRow(TAB(), current.row, lineFor(keys, rows[current.row - 2], next));
  const task = tidy(next);
  const mail = await sendHandoffs(handoffs(current, task, by), task);
  return json(200, { task, ...mail });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return json(405, { error: "Use GET or POST." });

  const denied = await checkAccess(event);
  if (denied) return json(denied.statusCode, { error: denied.error });

  if (!googleReady()) {
    return json(500, { error: "The Google connection isn't set up (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY and PROMO_SHEET_ID are needed)." });
  }

  try {
    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Request body isn't valid JSON." }); }
      if (body.action === "create") return await create(body);
      if (body.action === "update") return await update(body);
      return json(400, { error: `Unknown action: ${body.action}` });
    }

    const { keys, tasks, warnings } = await loadAll();
    let team = teamMembers().map((m) => m.name);
    if (!team.length) {
      team = [...new Set(tasks.flatMap((t) => [t.owner, t.reviewer]).filter(Boolean))].sort();
      warnings.push("TEAM_MEMBERS isn't set in Netlify, so the name list comes from owners in the sheet.");
    }
    return json(200, {
      tasks, team, statuses: STATUSES, types: TYPES, priorities: PRIORITIES, results: RESULTS,
      hasWaitingOn: keys.includes("waitingOn"), warnings, loadedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
