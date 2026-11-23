// netlify/lib/email.js
// Task Hub emails through Resend (the same account promo.js uses).
//
// Env vars:
//   RESEND_API_KEY   already set
//   PROMO_FROM       already set; used as the sender unless TASKS_FROM is set
//   TASKS_FROM       optional, e.g. "OverCoffee Task Hub <tasks@overcoffeeconsulting.com>"

const { ALLOWED_EMAIL_DOMAIN } = require("./auth");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function emailReady() {
  return Boolean(process.env.RESEND_API_KEY && (process.env.TASKS_FROM || process.env.PROMO_FROM));
}

// Only ever sends to company addresses.
async function sendEmail({ to, subject, intro, lines = [], link, linkText }) {
  if (!to || !to.toLowerCase().endsWith("@" + ALLOWED_EMAIL_DOMAIN)) throw new Error(`Not a company address: ${to}`);
  const rows = lines.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555872;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;color:#191a2e">${esc(v)}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f3f4f7;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#191a2e;padding:16px 24px;color:#ffffff;font-size:16px;font-weight:bold">OverCoffee <span style="color:#c9a84c">Task Hub</span></td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5;color:#191a2e">
<p style="margin:0 0 16px">${esc(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;margin:0 0 20px">${rows}</table>
<a href="${esc(link)}" style="display:inline-block;background:#191a2e;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">${esc(linkText || "Open the task")}</a>
</td></tr></table></td></tr></table></body></html>`;
  const text = [intro, "", ...lines.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), "", `${linkText || "Open the task"}: ${link}`].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.TASKS_FROM || process.env.PROMO_FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Resend returned ${res.status}`);
  }
}

// One email to several company addresses (used by the Monday digest).
async function sendBulk({ to, subject, html, text }) {
  const list = [...new Set((to || []).map((s) => String(s).trim().toLowerCase()))].filter((s) => s.endsWith("@" + ALLOWED_EMAIL_DOMAIN));
  if (!list.length) throw new Error("No @" + ALLOWED_EMAIL_DOMAIN + " addresses to send to.");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.TASKS_FROM || process.env.PROMO_FROM, to: list, subject, html, text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Resend returned ${res.status}`);
  }
  return list;
}

module.exports = { emailReady, sendEmail, sendBulk };
