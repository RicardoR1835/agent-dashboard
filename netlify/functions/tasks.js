// netlify/functions/tasks.js
// OverCoffee Task Hub: tasks API.
// Phase 1: read only. GET returns every task in the Tasks tab, plus the team list.
// Phase 2 adds create and update (by Task ID, with the Updated at check).
//
// Env vars:
//   TEAM_ACCESS_CODE, TEAM_MEMBERS                        see netlify/lib/auth.js
//   GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, PROMO_SHEET_ID   already set for promo.js
//   TASKS_TAB   optional, defaults to "Tasks"

const { checkAccess, teamMembers } = require("../lib/auth");
const { googleReady, readTab } = require("../lib/google");

const STATUSES = ["Backlog", "To do", "In progress", "Needs review", "Changes requested", "Scheduled", "Published", "Closed"];
const TYPES = ["CONTENT", "PROMO", "EMAIL", "SOCIAL", "SEO", "PAID", "OPS", "DESIGN", "WEB"];
const PRIORITIES = ["High", "Normal", "Low"];

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
  "parent task": "parentTask",
  "updated by": "updatedBy",
  "updated at": "updatedAt",
};
const REQUIRED = ["task id", "client", "title", "type", "status", "owner"];
const DATE_FIELDS = new Set(["created", "statusSince", "due"]);

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

const canonical = (list, v) => list.find((x) => x.toLowerCase() === String(v).trim().toLowerCase());

function parseTasks(header, rows) {
  const keys = header.map((h) => COLUMNS[String(h).trim().toLowerCase()] || null);
  const present = new Set(header.map((h) => String(h).trim().toLowerCase()));
  const missing = REQUIRED.filter((c) => !present.has(c));
  if (missing.length) {
    const nice = missing.map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase())).join(", ");
    throw new Error(`The Tasks tab is missing these column headers in row 1: ${nice}.`);
  }

  const tasks = [];
  const warnings = [];
  const seen = new Set();

  rows.forEach((line, i) => {
    const rowNumber = i + 2; // row 1 is the header
    const t = {};
    keys.forEach((k, col) => {
      if (!k) return;
      const raw = line[col] ?? "";
      if (k === "updatedAt") t[k] = toDate(raw, true);
      else if (DATE_FIELDS.has(k)) t[k] = toDate(raw, false);
      else t[k] = String(raw).trim();
    });
    if (!t.title && !t.taskId) return; // blank row

    if (!t.taskId) {
      warnings.push(`Row ${rowNumber} ("${t.title}") has no Task ID, so it's hidden. Give it one like T-0042.`);
      return;
    }
    if (seen.has(t.taskId)) {
      warnings.push(`Task ID ${t.taskId} is used more than once (row ${rowNumber}). Only the first one is shown.`);
      return;
    }
    seen.add(t.taskId);

    const status = canonical(STATUSES, t.status);
    if (!status) warnings.push(`${t.taskId} has status "${t.status}", which isn't one of the eight. It's shown under Backlog.`);
    t.status = status || "Backlog";

    const type = canonical(TYPES, t.type);
    if (t.type && !type) warnings.push(`${t.taskId} has type "${t.type}", which the hub doesn't know.`);
    t.type = type || String(t.type || "").toUpperCase();

    t.priority = canonical(PRIORITIES, t.priority) || (t.priority ? t.priority : "Normal");
    t.row = rowNumber;
    tasks.push(t);
  });

  return { tasks, warnings };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Use GET." });

  const denied = await checkAccess(event);
  if (denied) return json(denied.statusCode, { error: denied.error });

  if (!googleReady()) {
    return json(500, { error: "The Google connection isn't set up (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY and PROMO_SHEET_ID are needed)." });
  }

  try {
    const { header, rows } = await readTab(process.env.TASKS_TAB || "Tasks");
    const { tasks, warnings } = parseTasks(header, rows);

    let team = teamMembers().map((m) => m.name);
    if (!team.length) {
      team = [...new Set(tasks.flatMap((t) => [t.owner, t.reviewer]).filter(Boolean))].sort();
      warnings.push("TEAM_MEMBERS isn't set in Netlify, so the name list comes from owners in the sheet.");
    }

    return json(200, { tasks, team, statuses: STATUSES, types: TYPES, priorities: PRIORITIES, warnings, loadedAt: new Date().toISOString() });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

// exported for tests
exports._parseTasks = parseTasks;
