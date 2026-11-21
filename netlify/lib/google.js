// netlify/lib/google.js
// Google Sheets access through the existing service account (same one promo.js uses).
//
// Env vars (already set for promo.js):
//   GOOGLE_CLIENT_EMAIL   service account email
//   GOOGLE_PRIVATE_KEY    service account private key
//   PROMO_SHEET_ID        the OverCoffee Promo Log sheet (the Tasks tab lives here too)

const crypto = require("crypto");

let cached = { token: "", expires: 0 };

function googleReady() {
  const e = process.env;
  return Boolean(e.GOOGLE_CLIENT_EMAIL && e.GOOGLE_PRIVATE_KEY && e.PROMO_SHEET_ID);
}

async function googleToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.expires - 60 > now) return cached.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: process.env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const key = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error}`);
  cached = { token: data.access_token, expires: now + (data.expires_in || 3600) };
  return cached.token;
}

// Reads a whole tab. Returns { header: [...], rows: [[...], ...] }.
// Numbers stay numbers and dates come back as serial numbers, so typed dates
// read the same whatever format someone used in the sheet.
async function readTab(tab) {
  const token = await googleToken();
  const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${process.env.PROMO_SHEET_ID}/values/${range}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || String(res.status);
    if (/unable to parse range/i.test(msg)) {
      throw new Error(`There's no tab named "${tab}" in the Promo Log sheet yet.`);
    }
    if (res.status === 403) {
      throw new Error("The service account can't open the Promo Log sheet. Share the sheet with it as Editor.");
    }
    throw new Error(`Google Sheets: ${msg}`);
  }
  const [header = [], ...rows] = data.values || [];
  return { header, rows };
}

module.exports = { googleReady, googleToken, readTab };
