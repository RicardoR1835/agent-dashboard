// netlify/lib/auth.js
// Shared access check for the OverCoffee Task Hub (and later promo.js / agent.js).
//
// Env vars (Netlify > Site configuration > Environment variables):
//   TEAM_ACCESS_CODE   the code the team types once per browser
//   TEAM_MEMBERS       Name:email pairs, comma-separated, e.g.
//                      Ricardo:ricardo@overcoffeeconsulting.com,Paola:paola@overcoffeeconsulting.com
//                      Phase 1 only uses the names. Emails are used for handoff emails in Phase 2
//                      and are never sent to the browser.

const crypto = require("crypto");

const ALLOWED_EMAIL_DOMAIN = "overcoffeeconsulting.com";
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns null when access is fine, or a { statusCode, error } object to send back.
async function checkAccess(event) {
  const expected = process.env.TEAM_ACCESS_CODE;
  if (!expected) {
    return { statusCode: 500, error: "TEAM_ACCESS_CODE isn't set in Netlify yet, so nobody can sign in." };
  }
  const headers = event.headers || {};
  const given = headers["x-team-code"] || headers["X-Team-Code"] || "";
  // Comparing hashes keeps the comparison the same length and constant-time.
  if (!given || !crypto.timingSafeEqual(sha(given.trim()), sha(expected.trim()))) {
    await sleep(600); // slows down anyone guessing codes
    return { statusCode: 401, error: "That access code didn't work. Check it with Ricardo." };
  }
  return null;
}

// [{ name, email }] from TEAM_MEMBERS. Emails outside the company domain are dropped.
function teamMembers() {
  return String(process.env.TEAM_MEMBERS || "")
    .split(",")
    .map((pair) => {
      const [name, email = ""] = pair.split(":").map((s) => s.trim());
      const okEmail = email.toLowerCase().endsWith("@" + ALLOWED_EMAIL_DOMAIN) ? email : "";
      return name ? { name, email: okEmail } : null;
    })
    .filter(Boolean);
}

module.exports = { checkAccess, teamMembers, ALLOWED_EMAIL_DOMAIN };
