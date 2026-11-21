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

// Accepts the key however it was pasted: with or without quotes, a trailing comma,
// "private_key": in front, real line breaks or \n, or even the whole JSON file.
function privateKey() {
  let k = String(process.env.GOOGLE_PRIVATE_KEY || "").trim();
  if (k.startsWith("{")) {
    try { k = JSON.parse(k).private_key || k; } catch (_) {}
  }
  k = k.replace(/^"?private_key"?\s*:\s*/, "").replace(/,\s*$/, "").replace(/^["']+|["']+$/g, "");
  return k.replace(/\\n/g, "\n").trim() + "\n";
}

async function googleToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.expires - 60 > now) return cached.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: String(process.env.GOOGLE_CLIENT_EMAIL).trim(),
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  let sig;
  try {
    sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey(), "base64url");
  } catch (_) {
    throw new Error("GOOGLE_PRIVATE_KEY in Netlify isn't a readable key. Paste the private_key value from the JSON file again, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === "invalid_grant") {
      throw new Error("Google turned down the service account key. It may have been deleted; create a new key and paste it into Netlify.");
    }
    throw new Error(`Google sign-in failed: ${data.error_description || data.error}`);
  }
  cached = { token: data.access_token, expires: now + (data.expires_in || 3600) };
  return cached.token;
}

const quoteTab = (tab) => `'${tab.replace(/'/g, "''")}'`;
const sheetUrl = (path) => `https://sheets.googleapis.com/v4/spreadsheets/${process.env.PROMO_SHEET_ID}/values/${path}`;

async function call(url, options, tab) {
  const token = await googleToken();
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(options && options.headers) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || String(res.status);
    if (/unable to parse range/i.test(msg)) throw new Error(`There's no tab named "${tab}" in the Promo Log sheet yet.`);
    if (res.status === 403) throw new Error("The service account can't open the Promo Log sheet. Share the sheet with it as Editor.");
    throw new Error(`Google Sheets: ${msg}`);
  }
  return data;
}

// Reads a whole tab. Returns { header: [...], rows: [[...], ...] }.
// Numbers stay numbers and dates come back as serial numbers, so typed dates
// read the same whatever format someone used in the sheet.
async function readTab(tab) {
  const data = await call(
    sheetUrl(encodeURIComponent(quoteTab(tab))) + "?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER",
    {},
    tab
  );
  const [header = [], ...rows] = data.values || [];
  return { header, rows };
}

function columnLetter(n) {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Overwrites one row (1-based row number) with values, written exactly as given (no formulas).
async function writeRow(tab, rowNumber, values) {
  const range = `${quoteTab(tab)}!A${rowNumber}:${columnLetter(values.length)}${rowNumber}`;
  return call(sheetUrl(encodeURIComponent(range)) + "?valueInputOption=RAW", { method: "PUT", body: JSON.stringify({ values: [values] }) }, tab);
}

// Adds a row after the last row with data.
async function appendRow(tab, values) {
  const range = `${quoteTab(tab)}!A1`;
  return call(
    sheetUrl(encodeURIComponent(range)) + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
    { method: "POST", body: JSON.stringify({ values: [values] }) },
    tab
  );
}

module.exports = { googleReady, googleToken, privateKey, readTab, writeRow, appendRow };
