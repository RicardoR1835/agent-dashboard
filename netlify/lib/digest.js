// netlify/lib/digest.js
// Builds and sends the Monday digest: per client, what closed or went live last week,
// what's in review (flagging anything stuck more than 2 working days), what's overdue,
// what's due this week, and what's waiting on someone outside the team.
// Dates use Central time, since that's when the team reads it.
//
// Env vars:
//   TEAM_MEMBERS   recipients: everyone listed with an @overcoffeeconsulting.com address
//   DIGEST_TO      optional: comma-separated addresses to send to instead (for testing)

const { teamMembers } = require("./auth");
const { emailReady, sendBulk } = require("./email");
const store = require("./tasks-store");

const TZ = "America/Chicago";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dayIn = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nice = (iso) => (iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");
const DONE = ["Published", "Closed"];

function workingDaysBetween(fromIso, toIso) {
  if (!fromIso) return 0;
  let n = 0;
  for (let d = fromIso; d < toIso; ) {
    d = addDays(d, 1);
    const w = new Date(d + "T12:00:00Z").getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

function recipients() {
  const override = String(process.env.DIGEST_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  return override.length ? override : teamMembers().map((m) => m.email).filter(Boolean);
}

function buildDigest(tasks, now = new Date()) {
  const today = dayIn(now);
  const weekAgo = addDays(today, -7);
  const weekEnd = addDays(today, 6);
  const link = (t) => store.taskLink(t.taskId);

  const late = (t) => t.due && t.due < today && !DONE.includes(t.status);
  const buckets = {
    done: tasks.filter((t) => DONE.includes(t.status) && t.statusSince && t.statusSince >= weekAgo && t.statusSince < today),
    review: tasks.filter((t) => t.status === "Needs review"),
    overdue: tasks.filter(late),
    dueSoon: tasks.filter((t) => t.due && t.due >= today && t.due <= weekEnd && !DONE.includes(t.status)),
    waiting: tasks.filter((t) => t.waitingOn && t.status !== "Closed"),
  };
  const stuck = (t) => workingDaysBetween(t.statusSince, today) > 2;
  const stuckCount = buckets.review.filter(stuck).length;

  const clients = [...new Set(Object.values(buckets).flat().map((t) => t.client || "No client"))]
    .sort((a, b) => {
      const score = (c) => buckets.overdue.filter((t) => (t.client || "No client") === c).length * 10 + buckets.review.filter((t) => (t.client || "No client") === c).length;
      return score(b) - score(a) || a.localeCompare(b);
    });

  const line = (t, extra) => `<li style="margin:0 0 6px"><a href="${esc(link(t))}" style="color:#191a2e;font-weight:bold;text-decoration:none">${esc(t.title)}</a> <span style="color:#555872">${esc([t.type, t.owner || "unassigned", extra].filter(Boolean).join(", "))}</span></li>`;
  const block = (title, color, items) => (items.length ? `<p style="margin:12px 0 4px;font-size:14px;font-weight:bold;color:${color}">${title} (${items.length})</p><ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.45">${items.join("")}</ul>` : "");

  const perClient = clients.map((c) => {
    const of = (list) => list.filter((t) => (t.client || "No client") === c);
    return `<tr><td style="padding:16px 24px;border-top:1px solid #e3e5ec">
      <p style="margin:0;font-size:17px;font-weight:bold;color:#191a2e">${esc(c)}</p>
      ${block("Overdue", "#a12d2d", of(buckets.overdue).sort((a, b) => a.due.localeCompare(b.due)).map((t) => line(t, `due ${nice(t.due)}`)))}
      ${block("In review", "#7a5300", of(buckets.review).map((t) => line(t, `reviewer ${t.reviewer || "none"}${stuck(t) ? `, waiting ${workingDaysBetween(t.statusSince, today)} working days` : ""}`)))}
      ${block("Due this week", "#24527a", of(buckets.dueSoon).filter((t) => !late(t)).sort((a, b) => a.due.localeCompare(b.due)).map((t) => line(t, `due ${nice(t.due)}`)))}
      ${block("Waiting on someone else", "#555872", of(buckets.waiting).map((t) => line(t, `waiting on ${t.waitingOn}`)))}
      ${block("Done last week", "#2f6b3a", of(buckets.done).map((t) => line(t, t.status === "Closed" ? `closed${t.result ? `: ${t.result}` : ""}` : "published")))}
    </td></tr>`;
  }).join("");

  // Who has what: overdue and due this week per person
  const people = [...new Set([...buckets.overdue.map((t) => t.owner), ...buckets.dueSoon.map((t) => t.owner), ...buckets.review.map((t) => t.reviewer)].filter(Boolean))].sort();
  const peopleRows = people.map((p) => {
    const o = buckets.overdue.filter((t) => store.same(t.owner, p)).length;
    const d = buckets.dueSoon.filter((t) => store.same(t.owner, p) && !late(t)).length;
    const r = buckets.review.filter((t) => store.same(t.reviewer, p)).length;
    return `<tr><td style="padding:3px 16px 3px 0">${esc(p)}</td><td style="padding:3px 16px 3px 0;color:${o ? "#a12d2d" : "#555872"}">${o} overdue</td><td style="padding:3px 16px 3px 0">${d} due this week</td><td style="padding:3px 0">${r} to review</td></tr>`;
  }).join("");

  const counts = { overdue: buckets.overdue.length, review: buckets.review.length, stuck: stuckCount, dueSoon: buckets.dueSoon.filter((t) => !late(t)).length, done: buckets.done.length, waiting: buckets.waiting.length };
  const summary = `${counts.overdue} overdue · ${counts.review} in review${counts.stuck ? ` (${counts.stuck} stuck)` : ""} · ${counts.dueSoon} due this week · ${counts.done} done last week`;
  const hub = store.taskLink("").replace(/#$/, "");

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f3f4f7;font-family:Arial,Helvetica,sans-serif;color:#191a2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#191a2e;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:bold">OverCoffee <span style="color:#c9a84c">Monday digest</span><br><span style="font-size:13px;font-weight:normal;color:#d8dae3">Week of ${esc(nice(today))}</span></td></tr>
<tr><td style="padding:20px 24px 8px;font-size:16px"><p style="margin:0 0 12px;font-weight:bold">${esc(summary)}</p>
${peopleRows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 8px">${peopleRows}</table>` : ""}
<p style="margin:12px 0 0"><a href="${esc(hub)}" style="display:inline-block;background:#191a2e;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:bold">Open the Task Hub</a></p></td></tr>
${perClient || `<tr><td style="padding:16px 24px;font-size:15px">Nothing overdue, in review or due this week. Nice.</td></tr>`}
<tr><td style="padding:16px 24px;font-size:12px;color:#555872;border-top:1px solid #e3e5ec">"Stuck" means in review for more than 2 working days. Each title links to its task.</td></tr>
</table></td></tr></table></body></html>`;

  const textLines = [`OverCoffee Monday digest, week of ${nice(today)}`, summary, ""];
  for (const c of clients) {
    textLines.push(c.toUpperCase());
    const of = (list) => list.filter((t) => (t.client || "No client") === c);
    for (const [label, list] of [["Overdue", of(buckets.overdue)], ["In review", of(buckets.review)], ["Due this week", of(buckets.dueSoon).filter((t) => !late(t))], ["Waiting", of(buckets.waiting)], ["Done last week", of(buckets.done)]]) {
      if (list.length) textLines.push(`  ${label}: ${list.map((t) => `${t.title} (${t.owner || "unassigned"})`).join("; ")}`);
    }
    textLines.push("");
  }
  textLines.push(`Task Hub: ${hub}`);

  return { subject: `Monday digest: ${counts.overdue} overdue, ${counts.dueSoon} due this week (${nice(today)})`, html, text: textLines.join("\n"), counts };
}

async function sendDigest(now = new Date()) {
  if (!emailReady()) throw new Error("Email isn't set up (RESEND_API_KEY and PROMO_FROM are needed).");
  const { tasks } = await store.loadAll();
  const d = buildDigest(tasks, now);
  const sentTo = await sendBulk({ to: recipients(), subject: d.subject, html: d.html, text: d.text });
  return { ...d, sentTo };
}

module.exports = { buildDigest, sendDigest, recipients, dayIn };
