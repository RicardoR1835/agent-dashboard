// netlify/functions/tasks.js
// OverCoffee Task Hub: tasks API. The sheet logic lives in netlify/lib/tasks-store.js.
//   GET                                   every task in the Tasks tab, plus the team list
//   GET ?package=T-0041                   the saved promo package for that task (package.html)
//   POST { action: "create", task, by }   adds a task with the next Task ID
//   POST { action: "update", taskId, changes, expectedUpdatedAt, by }
//                                         changes one task. If someone else saved it after
//                                         expectedUpdatedAt, nothing is written and their
//                                         version comes back (409).
//
// Env vars:
//   TEAM_ACCESS_CODE, TEAM_MEMBERS                             see netlify/lib/auth.js
//   GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, PROMO_SHEET_ID    see netlify/lib/google.js
//   RESEND_API_KEY, PROMO_FROM (or TASKS_FROM)                 see netlify/lib/email.js
//   TASKS_TAB   optional, defaults to "Tasks"

const { checkAccess, teamMembers } = require("../lib/auth");
const { googleReady } = require("../lib/google");
const store = require("../lib/tasks-store");
const { getPackage } = require("../lib/packages");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});
const reply = ({ code, ...rest }) => json(code, rest);

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
      if (body.action === "create") return reply(await store.createTask(body.task, body.by));
      if (body.action === "update") return reply(await store.updateTask(body.taskId, body.changes, body.by, { expectedUpdatedAt: body.expectedUpdatedAt }));
      return json(400, { error: `Unknown action: ${body.action}` });
    }

    // GET ?package=T-0041 returns the saved promo package for that task
    const pkgId = (event.queryStringParameters || {}).package;
    if (pkgId) {
      const pkg = await getPackage(String(pkgId).trim());
      return pkg ? json(200, { package: pkg }) : json(404, { error: `No saved package for ${pkgId}. It's saved when someone emails Rodri from the promo tool.` });
    }

    const { keys, tasks, warnings } = await store.loadAll();
    let team = teamMembers().map((m) => m.name);
    if (!team.length) {
      team = [...new Set(tasks.flatMap((t) => [t.owner, t.reviewer]).filter(Boolean))].sort();
      warnings.push("TEAM_MEMBERS isn't set in Netlify, so the name list comes from owners in the sheet.");
    }
    return json(200, {
      tasks, team,
      statuses: store.STATUSES, types: store.TYPES, priorities: store.PRIORITIES, results: store.RESULTS, promotable: store.PROMOTABLE,
      hasWaitingOn: keys.includes("waitingOn"), hasRequestedBy: keys.includes("requestedBy"),
      warnings, loadedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
