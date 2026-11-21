// netlify/functions/promo.js
// OverCoffee Promo Sequence
// content -> social post examples -> promo email (copy + HTML) -> segment -> email Rodri + log to Google Sheet
//
// promo.html calls this once per step:
//   "clients" | "extract" | "social" (one call per platform, run in parallel) | "email" | "segment" | "notify"
//
// Env vars (Netlify > Site configuration > Environment variables):
//   ANTHROPIC_API_KEY     already set
//   RESEND_API_KEY        from resend.com
//   PROMO_FROM            e.g. "OverCoffee Promo <promo@overcoffeeconsulting.com>" (domain verified in Resend)
//   RODRI_EMAIL           where packages go
//   GOOGLE_CLIENT_EMAIL   service account email (from the Google Cloud JSON key)
//   GOOGLE_PRIVATE_KEY    service account private_key (paste as-is, \n sequences are fine)
//   PROMO_SHEET_ID        the Promo Log sheet's ID (the long part of its URL)
//   PROMO_SHEET_TAB       optional, defaults to "Promo Log"
//   PROFILES_TAB          optional, defaults to "Client Profiles" (same sheet: styling, voice, examples per client)
//   SLACK_WEBHOOK_URL     optional
//   TEAM_ACCESS_CODE      the Task Hub access code; every step checks it (see netlify/lib/auth.js)
//
// Task Hub link: notify accepts taskId and by. A SOCIAL, EMAIL or PROMO task gets the package
// attached and goes to Needs review; a CONTENT task (or no task) gets a new PROMO task for Rodri.

const crypto = require("crypto");
const { checkAccess, teamMembers } = require("../lib/auth");
const { privateKey } = require("../lib/google");
const tasks = require("../lib/tasks-store");
const MODEL = "claude-haiku-4-5-20251001"; // same model as agent.js

// ---------- client roster ----------
// rules: what the copy must respect.  brand: colors/logo for the HTML email (OverCoffee navy/gold if empty).
// brand fields: color (header + headline), accent (button), buttonText (text on button), logo (https URL, ~40px tall)
const CLIENT_GROUPS = [
  {
    label: "OverCoffee clients",
    clients: [
      { code: "TCC", name: "Texas Cannabis Clinic", rules: "Medical cannabis clinic. No health, cure or treatment-outcome claims. No imagery of consumption. Meta and Instagram restrict cannabis promotion, so keep social posts educational and about the clinic and its process, never the product.",
        // From TCC's existing drip emails in Drive
        brand: { color: "#1A3D2B", accent: "#1A3D2B", buttonText: "#FFFFFF", footer: "Austin, TX · texascannabisclinic.com · (512) 892-7092", unsubscribe: "{!$link.EmailAddressOptOutUrl}" } },
      { code: "H&S", name: "Heart & Soul Integrative Medicine", rules: "Healthcare practice. No promised outcomes or medical claims; educational, warm, trustworthy tone.",
        // Fonts from Brand Manual 2024 (Big Caslon, with Lusitana as its Google alternative; Outfit for body). Colors come from the website.
        brand: { headingFont: "'Big Caslon', Lusitana, Georgia, 'Times New Roman', serif", bodyFont: "Outfit, Arial, Helvetica, sans-serif" } },
      { code: "Cody", name: "Cody Young Septic", rules: "Local home-services business. Plain-spoken, practical, helpful; lead with the homeowner's problem." },
      { code: "Horse + Bow", name: "Horse + Bow" },
      { code: "RJD", name: "Rachel Jackson Design" },
      { code: "Continental", name: "Continental Caterers",
        // Brand manual lists PMS 302 and PMS 872 (metallic); these are close web equivalents
        brand: { color: "#003B5C", accent: "#85714D", buttonText: "#FFFFFF", footer: "475 Vandell Way, Suite A, Campbell, CA 95008" } },
      { code: "Feast for a King", name: "Feast For a King",
        // From BrandManual2025.pdf: green #1C362F, taupe #867766; Rosarivo headlines, Outfit body
        brand: { color: "#1C362F", accent: "#1C362F", buttonText: "#FFFFFF", headingFont: "Rosarivo, Georgia, 'Times New Roman', serif", bodyFont: "Outfit, Arial, Helvetica, sans-serif" } },
      { code: "White River", name: "White River" },
      { code: "Burnet Chamber", name: "Burnet Chamber of Commerce" },
      { code: "Marble Falls Chamber", name: "Marble Falls Chamber of Commerce" },
    ],
  },
  {
    label: "GT4 companies",
    clients: [
      { code: "PSRT", name: "PSRT" },
      { code: "Cafe Primavera", name: "Cafe Primavera" },
      { code: "Tutte al Forno", name: "Tutte al Forno" },
      { code: "Barworks", name: "Barworks",
        // From ColorPaletteFinal.pdf: deep teal #023434, teal #0F797A, orange #CF6F10
        brand: { color: "#023434", accent: "#0F797A", buttonText: "#FFFFFF", footer: "8510 Production Ave, San Diego, CA 92121 · 858-566-6077 · barworkscatering.com" } },
    ],
  },
  {
    label: "Internal",
    clients: [{ code: "OCC", name: "OverCoffee Consulting", rules: "Our own agency. Friendly, expert, no jargon; small businesses are the audience.", brand: { color: "#191a2e", accent: "#c9a84c", buttonText: "#191a2e" } }],
  },
];

// Claude Project for each client, used by the "Refine in Claude" button.
const PROJECT_IDS = {
  TCC: "019d7d60-d2df-719a-aea4-93eb0d506f52",
  "Horse + Bow": "019dacb8-233d-742d-8d0d-62e04d9db806",
  Cody: "019dacc9-0f9d-7096-b3aa-4573e4772658",
  "H&S": "019d8840-8397-75a8-8d9f-9775c93e65e4",
  "Tutte al Forno": "019dfe3f-8f27-7325-9fd4-cac4b9058ed7",
  RJD: "019dacb1-586b-77ec-869a-70bd25cae2ba",
  "Cafe Primavera": "019dacaa-d1fc-76eb-afc7-4cbe1fa493f5",
  PSRT: "019d9bf8-83de-7358-b95d-70b9c2e8c302",
  Barworks: "019d9bec-e197-729b-adf8-98a6ae98b58c",
  Continental: "019d884f-c64f-7044-9429-52b9b92c443c",
  "Feast for a King": "019d883b-230c-7697-8e97-b0894aa59f64",
  OCC: "019dad45-4ac5-7394-8761-30d68683ee01", // Agency Master
};

// Each client's "06_Claude Project Docs" folder in Drive: the same docs loaded into their Claude Project.
// The "Project docs folder" column in Client Profiles overrides these.
const DOC_FOLDERS = {
  TCC: "1ryPzMemMm9T2SsFIXrSce28TWWq-Z5qn",
  "H&S": "1plxyXaRceeNC1yySoOTWOJMNx1qZgrpS",
  Cody: "1iG5Tm9fxARjQJnqdN6N1Kqiu_sxPqnYy",
  "Horse + Bow": "1cR2trPk17fD-PowYf3kSiBH_sms3xSMU",
  RJD: "1XoO4WruElMOULvSFV8jPCx9Gi0Y7dT3W",
  Continental: "1_OEhAymspyWcMO7Gzp6sG2o8y76cJVtB",
  "Feast for a King": "1NsaP5M1uUicpKGF0F1f5fLwS5snzsrdi",
  "White River": "1CFV5YpVIFf71p1SgPZ-uWucTztEHQY6K",
  PSRT: "17iK5gX1vTOaHLEzYkXpw05yMjOUHEz5u",
  "Cafe Primavera": "1GcxtpKtZJPT57zGKZBdYbUSSPdIH8qH5",
  "Tutte al Forno": "1pksEkza-9FWHK3J8C3qKx2td1bzpGzn-",
  Barworks: "1CTekkWvuEay3CZ0RxjA1KHyZR_JnkH9P",
};
// GT4 master docs (house brand guidelines) are also read for every GT4 company.
const GT4_FOLDER = "17KBKz75TCSMUFpjr8JwtvK4ZNye5d-dX";
const GT4_CODES = ["PSRT", "Cafe Primavera", "Tutte al Forno", "Barworks"];

// Client websites, used to auto-detect colors, fonts and logo when nothing else is set.
// A "Website" column in Client Profiles overrides these; for clients not listed, the site
// named in their brand-guidelines doc is used.
const WEBSITES = {
  TCC: "https://texascannabisclinic.com",
  Barworks: "https://barworkscatering.com",
  Continental: "https://continentalcaterer.com",
  "Feast for a King": "https://feastforakingcatering.com",
  "Cafe Primavera": "https://cafeprimavera.com",
  PSRT: "https://psrt.com",
  "Tutte al Forno": "https://tuttealforno.com",
  OCC: "https://overcoffeeconsulting.com",
};

// Which docs to read from a folder, and how much of each (characters).
const DOC_PICKS = [
  { match: /brand-guidelines/i, label: "Brand guidelines", max: 9000 },
  { match: /audience-personas/i, label: "Audience personas", max: 7000 },
  { match: /approved-content-examples/i, label: "Approved content examples", max: 8000 },
];

const CLIENTS = Object.fromEntries(CLIENT_GROUPS.flatMap((g) => g.clients.map((c) => [c.code, c])));
// Email domains that may be CC'd on a package (keeps the page from being usable to email anyone else).
const ALLOWED_CC_DOMAINS = ["overcoffeeconsulting.com"];

const DEFAULT_BRAND = { color: "#191a2e", accent: "#c9a84c", buttonText: "#191a2e", logo: "" };
const DEFAULT_FONT = "Arial, Helvetica, sans-serif";

// ---------- helpers ----------

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- client profiles (Google Sheet tab) ----------
// Header row (any order, case doesn't matter):
// Client | Header color | Button color | Button text color | Logo URL | Heading font | Body font | Footer |
// Unsubscribe link | Voice | Always | Never | Example post 1 | Example post 2 | Example email
// A row with Client = ALL holds house rules (Always / Never) that apply to every client.

let profileCache = { at: 0, rows: null };

async function getProfiles() {
  const env = process.env;
  if (!(env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY && env.PROMO_SHEET_ID)) {
    return { rows: {}, note: "The Client Profiles sheet isn't connected yet, so default styling and voice were used." };
  }
  if (profileCache.rows && Date.now() - profileCache.at < 60000) return { rows: profileCache.rows };
  const token = await googleToken();
  const tab = env.PROFILES_TAB || "Client Profiles";
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.PROMO_SHEET_ID}/values/${encodeURIComponent(tab + "!A1:Z300")}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Client Profiles: ${data.error?.message || res.status}.`);
  const [header = [], ...lines] = data.values || [];
  const keys = header.map((h) => String(h).trim().toLowerCase());
  const rows = {};
  for (const line of lines) {
    const row = {};
    keys.forEach((k, i) => (row[k] = String(line[i] ?? "").trim()));
    if (row.client) rows[row.client.toLowerCase()] = row;
  }
  profileCache = { at: Date.now(), rows };
  return { rows };
}

async function profileFor(code) {
  const base = CLIENTS[code] || { code, name: code };
  let rows = {};
  let note = "";
  try {
    const r = await getProfiles();
    rows = r.rows;
    note = r.note || "";
  } catch (err) {
    note = `${err.message} Default styling and voice were used.`;
  }
  const p = rows[String(code).toLowerCase()];
  if (!note && !p) note = `There's no row for "${code}" in Client Profiles yet, so default styling and voice were used.`;
  return { base, p: p || {}, all: rows.all || {}, note };
}

function clientBlock({ base, p, all }, kind, context) {
  const parts = [`Client: ${base.name}`];
  if (context) {
    parts.push(
      "CLIENT DOCS (from the client's Claude Project). Follow their voice, language, audience and CTA guidance. If they describe output formats, our JSON format below still wins.\n\n" +
        context
    );
  }
  if (base.rules) parts.push(`Rules: ${base.rules}`);
  if (p.voice) parts.push(`Voice: ${p.voice}`);
  const always = [all.always, p.always].filter(Boolean).join("\n");
  const never = [all.never, p.never].filter(Boolean).join("\n");
  if (always) parts.push(`Always:\n${always}`);
  if (never) parts.push(`Never:\n${never}`);
  const examples =
    kind === "social" ? [p["example post 1"], p["example post 2"]].filter(Boolean)
    : kind === "email" ? [p["example email"]].filter(Boolean)
    : [];
  if (examples.length) {
    parts.push(
      "Approved examples from this client. Match their voice, rhythm, length and formatting. Do not reuse their facts or offers:\n" +
        examples.map((e, i) => `--- Example ${i + 1} ---\n${e}`).join("\n")
    );
  }
  return parts.join("\n\n");
}

const color = (v, fallback) => (/^#[0-9a-f]{3,8}$/i.test(String(v || "").trim()) ? String(v).trim() : fallback);
const fontStack = (v) => String(v || "").replace(/["<>;{}]/g, "").trim() || DEFAULT_FONT;

// Extra rules when the run starts from a topic instead of a real page.
function sourceRules(content) {
  if (!content || !content.fromTopic) return "";
  return `SOURCE: This run starts from a topic idea, not a published page. The only facts you may use are in CLIENT DOCS above (services, locations, taglines, booking details, audience). Do not state prices, dates, menu items, offers, awards, statistics or results unless they appear there. Where a specific detail would help, write a placeholder like [ADD: holiday booking deadline] instead of inventing one. The goal is to drive people to the link given.\n`;
}

function languageLine(language) {
  return language === "Spanish"
    ? "Write everything in Spanish (neutral Latin American Spanish unless the content says otherwise)."
    : "Write everything in English.";
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI step didn't return usable output. Run it again.");
  return JSON.parse(clean.slice(start, end + 1));
}

async function claudeJSON(system, user, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: system + "\n\nRespond with ONLY a JSON object. No preamble, no markdown fences.",
        messages: [{ role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Anthropic error ${res.status}`);
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return parseJSON(text);
  } finally {
    clearTimeout(timer);
  }
}

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;|&lsquo;|&#39;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const PLATFORM_RULES = {
  Instagram: 'Captions have no clickable links, so point to "link in bio". 3–8 relevant hashtags. Line breaks for readability.',
  Facebook: "Conversational, the link is fine in the post, 0–3 hashtags.",
  LinkedIn: "Professional, insight-led opening line, 1–3 hashtags.",
  "Google Business Profile": "Under 1,500 characters, no hashtags, ends with a clear action.",
  X: "Under 280 characters including the link.",
};

// ---------- steps ----------

// ---------- client docs from Google Drive ----------

const folderIdFrom = (v) => {
  const t = String(v || "").trim();
  const m = t.match(/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : /^[A-Za-z0-9_-]{20,}$/.test(t) ? t : "";
};

async function driveList(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Drive: ${data.error?.message || res.status}`);
  return data.files || [];
}

async function driveText(token, file) {
  let url;
  if (file.mimeType === "application/vnd.google-apps.document") {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`;
  } else if (/^text\//.test(file.mimeType) || /\.(md|txt)$/i.test(file.name)) {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
  } else {
    return ""; // PDFs and images are skipped
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? (await res.text()).replace(/\n{3,}/g, "\n\n").trim() : "";
}

async function readFolder(token, folderId, picks, prefix = "") {
  const files = await driveList(token, folderId);
  const out = [];
  for (const pick of picks) {
    const file = files.find((f) => pick.match.test(f.name));
    if (!file) continue;
    const text = await driveText(token, file);
    if (text.length < 200) continue; // empty placeholder docs
    out.push({ label: prefix + pick.label, text: text.slice(0, pick.max) });
  }
  return out;
}

// ---------- brand styling from the client's website ----------

const hex6 = (h) => {
  let x = String(h || "").replace("#", "").toLowerCase();
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(x) ? "#" + x.toUpperCase() : null;
};
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = (h) => {
  const [r, g, b] = rgbOf(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const hsl = (h) => {
  const [r, g, b] = rgbOf(h);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l };
};
const brandish = (h) => { const { s, l } = hsl(h); return s >= 0.2 && l > 0.08 && l < 0.88; };
const distance = (a, b) => { const x = rgbOf(a), y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const textOn = (bg) => (contrast(bg, "#FFFFFF") >= 4.5 ? "#FFFFFF" : "#111111");
const darken = (h) => {
  let [r, g, b] = rgbOf(h).map((c) => c * 255);
  for (let i = 0; i < 20 && contrast(hex6([r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")), "#FFFFFF") < 4.5; i++) {
    [r, g, b] = [r, g, b].map((c) => c * 0.88);
  }
  return hex6([r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join(""));
};

// Colors that come from page builders, WordPress or social widgets, not the brand.
const NOT_BRAND = new Set(["#6EC1E4", "#61CE70", "#54595F", "#7A7A7A", "#0073AA", "#2271B1", "#135E96", "#3B5998", "#1DA1F2",
  "#0077B5", "#00A0D2", "#CC1818", "#D63638", "#00A32A", "#DBA617", "#4AB866", "#3858E9", "#007CBA", "#006BA1", "#F0B849",
  "#1E73BE", "#FF0000", "#E1306C", "#25D366", "#1877F2", "#FF6900", "#FCB900", "#7BDCB5", "#00D084", "#8ED1FC", "#0693E3",
  "#ABB8C3", "#EB144C", "#F78DA7", "#9B51E0", "#CF2E2E"]);

const SERIF = /serif|playfair|caslon|garamond|lora|merriweather|libre baskerville|cormorant|lusitana|rosarivo|dm serif|georgia|bodoni|didot|crimson|spectral|prata/i;
const stackFor = (name) => {
  const n = String(name || "").replace(/["']/g, "").trim();
  if (!n) return "";
  return SERIF.test(n) ? `'${n}', Georgia, 'Times New Roman', serif` : `'${n}', Arial, Helvetica, sans-serif`;
};
const IGNORE_FONTS = /^(inherit|initial|unset|sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont|segoe ui|helvetica|arial|font ?awesome.*|dashicons|eicons|fa-.*|swiper-icons|star|var\(.*)$/i;

async function fetchText(url, ms, max = 600000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; OverCoffeePromoBot/1.0)" }, redirect: "follow", signal: ctrl.signal });
    return r.ok ? (await r.text()).slice(0, max) : "";
  } catch (_) {
    return "";
  } finally {
    clearTimeout(t);
  }
}

function styleFromPage(html, css, baseUrl) {
  // 1. Named brand variables (Elementor, WordPress block themes, common frameworks)
  const vars = {};
  for (const m of css.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,6})\b/gi)) {
    const k = m[1].toLowerCase();
    if (!(k in vars)) vars[k] = hex6(m[2]);
  }
  const fromVars = (names) => names.map((n) => vars[n]).filter((h) => h && !NOT_BRAND.has(h) && brandish(h));
  const named = fromVars(["e-global-color-primary", "wp--preset--color--primary", "primary", "color-primary", "brand-primary",
    "e-global-color-accent", "wp--preset--color--accent", "wp--preset--color--secondary", "e-global-color-secondary",
    "accent", "color-accent", "secondary", "color-secondary", "brand", "brand-color"]);
  const theme = hex6((html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-f]{3,6})/i) || [])[1]);

  // 2. Most-used saturated colors in the stylesheets
  const counts = {};
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const h = hex6(m[1]);
    if (h && brandish(h) && !NOT_BRAND.has(h)) counts[h] = (counts[h] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([h]) => h);

  const candidates = [...new Set([...named, theme, ...ranked].filter((h) => h && brandish(h) && !NOT_BRAND.has(h)))];
  let color = null, accent = null;
  if (candidates.length) {
    color = candidates.find((h) => contrast(h, "#FFFFFF") >= 4.5) || darken(candidates[0]);
    accent = candidates.find((h) => h !== color && distance(h, color) > 0.25) || color;
  }

  // Fonts: Elementor typography vars, Google Fonts links, then the most-used font-family
  let fonts = [];
  const eHead = (css.match(/--e-global-typography-primary-font-family\s*:\s*["']?([^"';}]+)/i) || [])[1];
  const eBody = (css.match(/--e-global-typography-text-font-family\s*:\s*["']?([^"';}]+)/i) || [])[1];
  if (eHead) fonts = [eHead, eBody || eHead];
  if (!fonts.length) {
    for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)) {
      for (const f of m[1].replace(/&amp;/g, "&").matchAll(/family=([^&:]+)/g)) fonts.push(decodeURIComponent(f[1].replace(/\+/g, " ")).split("|")[0]);
    }
  }
  if (!fonts.length) {
    const fc = {};
    for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
      const first = m[1].split(",")[0].replace(/["'!]|important/g, "").trim();
      if (first && !IGNORE_FONTS.test(first)) fc[first] = (fc[first] || 0) + 1;
    }
    fonts = Object.entries(fc).sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 2);
  }
  fonts = [...new Set(fonts.map((f) => f.trim()).filter((f) => f && !IGNORE_FONTS.test(f)))];

  // Logo: WordPress custom-logo, else the first image that says "logo"; email needs PNG/JPG, not SVG
  let logo = "";
  const tag =
    (html.match(/<img[^>]+class=["'][^"']*custom-logo[^"']*["'][^>]*>/i) || [])[0] ||
    (html.match(/<img[^>]+(?:class|id|alt|src)=["'][^"']*logo[^"']*["'][^>]*>/i) || [])[0] || "";
  const src = (tag.match(/\s(?:data-src|src)=["']([^"']+)["']/i) || [])[1] || "";
  if (src && !/^data:|\.svg(\?|$)/i.test(src)) {
    try { logo = new URL(src.replace(/&amp;/g, "&"), baseUrl).href.replace(/^http:/, "https:"); } catch (_) {}
  }

  return {
    color, accent,
    buttonText: accent ? textOn(accent) : null,
    headingFont: stackFor(fonts[0]),
    bodyFont: stackFor(fonts[1] || fonts[0]),
    logo,
  };
}

async function siteStyle(website) {
  const base = new URL(/^https?:\/\//i.test(website) ? website : "https://" + website);
  const html = await fetchText(base.href, 5000);
  if (!html) throw new Error("no page");
  const links = [...html.matchAll(/<link[^>]+>/gi)]
    .map((m) => m[0])
    .filter((t) => /stylesheet/i.test(t))
    .map((t) => (t.match(/href=["']([^"']+)["']/i) || [])[1])
    .filter(Boolean)
    .map((h) => { try { return new URL(h.replace(/&amp;/g, "&"), base).href; } catch (_) { return null; } })
    .filter((u) => u && !/fonts\.googleapis|font-?awesome|dashicons|wp-block-library|jquery|swiper|animate/i.test(u));
  const score = (u) => (/elementor\/css\/(post|global)|global|custom|theme|style/i.test(u) ? 1 : 0);
  links.sort((a, b) => score(b) - score(a));
  const sheets = await Promise.all(links.slice(0, 6).map((u) => fetchText(u, 3500, 400000)));
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const attrs = [...html.matchAll(/style=["']([^"']+)["']/gi)].map((m) => m[1]).join(";\n");
  const out = styleFromPage(html, [inline, attrs, ...sheets].join("\n"), base.href);
  return { ...out, source: base.hostname.replace(/^www\./, "") };
}

const urlish = (v) => {
  const t = (String(v || "").trim().split(/\s+/)[0] || "").replace(/^[*\[(]+/, "").replace(/[)\].,;*]+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : /^[a-z0-9.-]+\.[a-z]{2,}/i.test(t) ? "https://" + t : "";
};

// Called once per run; the page passes the result to every writing step.
async function context({ client }) {
  const env = process.env;
  const notes = [];
  const google = env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY;

  let p = {};
  if (google && env.PROMO_SHEET_ID) {
    try { p = (await getProfiles()).rows[String(client).toLowerCase()] || {}; } catch (_) {}
  }

  // Start reading the website right away if we already know it
  let website = urlish(p.website) || WEBSITES[client] || "";
  let sitePromise = website ? siteStyle(website).catch(() => null) : null;

  const docs = [];
  if (google) {
    const folder = folderIdFrom(p["project docs folder"]) || DOC_FOLDERS[client];
    if (folder) {
      try {
        const token = await googleToken();
        docs.push(...(await readFolder(token, folder, DOC_PICKS)));
        if (GT4_CODES.includes(client)) {
          try {
            docs.push(...(await readFolder(token, GT4_FOLDER, [{ match: /brand-guidelines/i, label: "Brand guidelines", max: 5000 }], "GT4 ")));
          } catch (_) {}
        }
      } catch (err) {
        notes.push(`Couldn't read the Project docs (${err.message}).`);
      }
      if (!docs.length && !notes.length) notes.push("The Project docs folder had no filled-in brand, audience or example docs.");
    } else {
      notes.push("No Project docs folder is set for this client.");
    }
  } else {
    notes.push("Google access isn't set up yet, so the client's Project docs weren't read.");
  }

  // No website on file? Use the one named in the brand guidelines doc.
  if (!website) {
    const brandDoc = (docs.find((d) => d.label === "Brand guidelines") || {}).text || "";
    website = urlish((brandDoc.match(/website[^:\n]*:\**\s*\[?((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}[^\s\])]*)/i) || [])[1]);
    if (website) sitePromise = siteStyle(website).catch(() => null);
  }
  const site = sitePromise ? await sitePromise : null;

  // A booking link from the docs, used as the button link for topic runs
  const allDocs = docs.map((d) => d.text).join("\n");
  const booking =
    (allDocs.match(/booking[^:\n]*:\**\s*\[?((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\/[^\s\])]*)/i) || [])[1] ||
    (allDocs.match(/((?:https?:\/\/)?[a-z0-9-]+\.tripleseat\.com\/[^\s\])]*)/i) || [])[1] || "";

  return {
    context: docs.map((d) => `=== ${d.label} ===\n${d.text}`).join("\n\n"),
    sources: docs.map((d) => d.label),
    note: notes.join(" "),
    website,
    bookingUrl: urlish(booking),
    site,
  };
}

async function clients() {
  let rows = {};
  try {
    rows = (await getProfiles()).rows || {};
  } catch (_) {}
  const linkFor = (code) => {
    const fromSheet = rows[code.toLowerCase()]?.["claude project link"] || "";
    if (/^https:\/\/claude\.ai\/project\//i.test(fromSheet)) return fromSheet.trim();
    return PROJECT_IDS[code] ? `https://claude.ai/project/${PROJECT_IDS[code]}` : "";
  };
  return {
    groups: CLIENT_GROUPS.map((g) => ({
      label: g.label,
      clients: g.clients.map(({ code, name }) => ({ code, name, projectUrl: linkFor(code) })),
    })),
  };
}

// 1. Read the content: a URL (blog post, landing page) or pasted text.
async function extract({ url, text, topic }) {
  if (topic && topic.trim()) {
    const t = topic.trim();
    return { title: t.split("\n")[0].slice(0, 120), description: "", text: `TOPIC (there is no source page): ${t.slice(0, 2000)}`, url: "", fromTopic: true };
  }
  if (text && text.trim()) {
    const t = text.trim();
    return { title: t.split("\n")[0].slice(0, 120), description: "", text: t.slice(0, 12000), url: url || "" };
  }
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("Add a full URL (https://...) or paste the content.");

  const res = await fetch(url, { headers: { "user-agent": "OverCoffeePromoBot/1.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't open that URL (${res.status}). Paste the content instead.`);
  const html = await res.text();

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
  const description = decode(
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || ""
  ).trim();

  let body =
    (html.match(/<article[\s\S]*?<\/article>/i) || [])[0] ||
    (html.match(/<main[\s\S]*?<\/main>/i) || [])[0] ||
    html;
  body = body
    .replace(/<(script|style|noscript|svg|nav|footer|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|h\d|li|div|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  body = decode(body).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

  if (body.length < 200) {
    throw new Error("Couldn't read enough text from that page (it may load with JavaScript). Paste the content instead.");
  }
  return { title, description, text: body.slice(0, 12000), url };
}

// 2. Two post examples for ONE platform (the page runs every platform in parallel).
async function social({ client, content, platform, goal, language, context }) {
  const prof = await profileFor(client);
  const system =
    "You are OverCoffee Consulting's social media writer. You turn one piece of client content into platform-native posts that drive people to it. You never invent facts, prices, dates, offers or statistics that aren't in the content.";
  const user = `${clientBlock(prof, "social", context)}
${sourceRules(content)}${languageLine(language)}
Goal of the promotion: ${goal || "get people to read the content and take its next step"}
Content URL: ${content.url || "(none, pasted content)"}

CONTENT
Title: ${content.title}
${content.description ? `Summary: ${content.description}\n` : ""}${content.text.slice(0, 8000)}

Platform: ${platform}
Platform rules: ${PLATFORM_RULES[platform] || "Native to the platform."}

Write TWO example posts for this platform that take clearly different angles (for example: a question hook vs. a practical tip, or a story vs. a straight announcement). Hook in the first line. Each stands on its own.

JSON shape:
{"platform":"${platform}","variations":[{"angle":"2–4 word label","copy":"","hashtags":["#example"],"visual":"one-line image or video idea using what the client likely has"}]}`;
  const out = await claudeJSON(system, user, 1100);
  out.platform = platform;
  return out;
}

// 3. Promo email copy. The page wraps it in the tested HTML template using the client's brand.
async function email({ client, content, posts, goal, language, context, site }) {
  const prof = await profileFor(client);
  const system =
    "You are OverCoffee Consulting's email marketer. You write short promotional emails that send subscribers to a client's new content. You never invent facts, offers, prices or dates that aren't in the content.";
  const angle = (posts || [])
    .slice(0, 2)
    .map((p) => `${p.platform}: ${String(p.variations?.[0]?.copy || "").slice(0, 300)}`)
    .join("\n");
  const user = `${clientBlock(prof, "email", context)}
${sourceRules(content)}${languageLine(language)}
Goal: ${goal || "get subscribers to read the content"}
Link the button to: ${content.url || "[ADD LINK]"}

CONTENT
Title: ${content.title}
${content.text.slice(0, 8000)}

Social angle already chosen (keep the email consistent with it):
${angle || "(none)"}

Write one promo email: 3 subject line options (under 50 characters, no clickbait, no ALL CAPS), a preheader (under 90 characters) that adds to the subject instead of repeating it, a headline (under 70 characters), a body of 90–160 words in 2–4 short paragraphs separated by blank lines (plain text, no markdown), button text (2–5 words), and an optional one-line P.S.

JSON shape:
{"subject_lines":["","",""],"preheader":"","headline":"","body":"","cta_text":"","cta_url":"","ps":""}`;
  const copy = await claudeJSON(system, user, 1000);
  const { base, p } = prof;
  const code = base.brand || {};
  const web = site || {};

  // Priority for every field: Client Profiles sheet > built-in brand (from Drive) > client website > OverCoffee default
  const firstColor = (...vals) => vals.map((v) => hex6(v)).find(Boolean);
  const headerColor = firstColor(p["header color"], code.color, web.color, DEFAULT_BRAND.color);
  let accent, buttonText;
  if (hex6(p["button color"])) { accent = hex6(p["button color"]); buttonText = hex6(p["button text color"]) || textOn(accent); }
  else if (hex6(code.accent)) { accent = hex6(code.accent); buttonText = hex6(code.buttonText) || textOn(accent); }
  else if (hex6(web.accent)) { accent = hex6(web.accent); buttonText = web.buttonText || textOn(accent); }
  else { accent = DEFAULT_BRAND.accent; buttonText = DEFAULT_BRAND.buttonText; }
  const logo = [p["logo url"], code.logo, web.logo].find((v) => /^https:\/\//i.test(v || "")) || "";

  let styleNote;
  if (hex6(p["header color"]) || hex6(p["button color"])) styleNote = "Styling: from the Client Profiles sheet.";
  else if (hex6(code.color)) styleNote = "Styling: this client's brand colors from Drive.";
  else if (web.color) styleNote = `Styling: picked up automatically from ${web.source}. Check it in the preview; to lock in different colors, fill in the color columns in Client Profiles.`;
  else styleNote = "Styling: no brand colors found, so OverCoffee's defaults were used. Add this client's colors in Client Profiles.";

  return {
    ...copy,
    cta_url: copy.cta_url || content.url || "",
    profileNote: styleNote,
    brand: {
      name: base.name,
      color: headerColor,
      accent,
      buttonText,
      logo,
      headingFont: fontStack(p["heading font"] || code.headingFont || web.headingFont),
      bodyFont: fontStack(p["body font"] || code.bodyFont || web.bodyFont),
      footer: p.footer || code.footer || "",
      unsubscribe: p["unsubscribe link"] || code.unsubscribe || "",
    },
  };
}

// 4. Who should get it. Grounded in the client's real segments when the team pastes them in.
async function segment({ client, content, email: mail, goal, knownSegments, context }) {
  const prof = await profileFor(client);
  const system =
    "You are OverCoffee Consulting's CRM strategist. You recommend which audience segment should receive a promo email. You never invent list sizes, open rates or other numbers.";
  const user = `${clientBlock(prof, null, context)}
${sourceRules(content)}Goal: ${goal || "get subscribers to read the content"}
Content title: ${content.title}
Content summary: ${(content.description || content.text).slice(0, 1500)}
Email subject options: ${(mail?.subject_lines || []).join(" | ")}

Segments and lists that already exist for this client:
${knownSegments && knownSegments.trim() ? knownSegments.trim() : "(none provided)"}

If existing segments are provided, the primary pick MUST be one of them (exists: true). You may also propose new segments, marked exists: false, with criteria simple enough to build in Klaviyo, Mailchimp, Salesforce Marketing Cloud or GoHighLevel.
If none are provided, propose segments by criteria and mark them exists: false.
Also say who to exclude (recent purchasers, people who already got this content, unengaged contacts, etc.) and a short timing note relative to the social posts.

JSON shape:
{"primary":{"name":"","who":"","why":"","exists":true},"secondary":[{"name":"","who":"","why":"","exists":false}],"exclude":[""],"timing":""}`;
  return claudeJSON(system, user, 900);
}

// 5. Email the package to Rodri (HTML email attached) and log a row in the Promo Log sheet.
function packageHtml({ clientName, url, sections, taskUrl }) {
  const blocks = (sections || [])
    .map((s) => {
      const items = (s.items || [])
        .map(
          (t) =>
            `<div style="border:1px solid #d8dae3;border-radius:8px;padding:14px 16px;margin:0 0 12px;font:16px/1.55 Arial,sans-serif;color:#222;white-space:pre-wrap">${esc(t)}</div>`
        )
        .join("");
      return `<h2 style="font:bold 18px/1.3 Arial,sans-serif;color:#191a2e;margin:28px 0 10px;padding-bottom:4px;border-bottom:2px solid #c9a84c">${esc(s.heading)}</h2>${items}`;
    })
    .join("");
  return `<div style="max-width:640px;margin:0 auto;padding:16px">
<p style="font:16px/1.55 Arial,sans-serif;color:#222">Hi Rodri, a promo package for <strong>${esc(clientName)}</strong> is ready for your review. Nothing has been posted or sent yet. The ready-to-paste HTML email is attached.</p>
${url ? `<p style="font:16px/1.55 Arial,sans-serif;color:#222">Content: <a href="${esc(url)}">${esc(url)}</a></p>` : ""}
${blocks}
<p style="font:16px/1.5 Arial,sans-serif;color:#555;margin-top:32px">${taskUrl ? `Track it in the Task Hub: <a href="${esc(taskUrl)}">${esc(taskUrl)}</a>. Mark it Scheduled, then Published, then add the Result there.` : "Update the status in the Promo Log sheet once it's scheduled."} Reply to this email with changes.</p>
</div>`;
}

function packageText({ clientName, url, sections, taskUrl }) {
  return [
    `Hi Rodri, a promo package for ${clientName} is ready for your review. Nothing has been posted or sent yet. The ready-to-paste HTML email is attached.`,
    url ? `Content: ${url}` : "",
    taskUrl ? `Task Hub: ${taskUrl}` : "",
    ...(sections || []).map((s) => `== ${s.heading} ==\n\n${(s.items || []).join("\n\n---\n\n")}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function googleToken() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: process.env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey(), "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error}`);
  return data.access_token;
}

async function logToSheet(row) {
  const tab = process.env.PROMO_SHEET_TAB || "Promo Log";
  const token = await googleToken();
  const range = encodeURIComponent(`${tab}!A:M`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${process.env.PROMO_SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheet: ${data.error?.message || res.status}`);
}

// Writes the package back to the Task Hub before the email goes out, so the email can link to the task.
//   SOCIAL / EMAIL / PROMO task: attach the package to it and send it to Rodri for review.
//   CONTENT task, or no task: create a PROMO task for Rodri (linked to the CONTENT task).
async function linkTask({ client, title, url, taskId, by, fromTopic }) {
  const env = process.env;
  const rodri = teamMembers().find((m) => env.RODRI_EMAIL && tasks.same(m.email, env.RODRI_EMAIL))?.name || "Rodri";
  const output = `https://docs.google.com/spreadsheets/d/${env.PROMO_SHEET_ID}/edit`;
  const today = new Date().toISOString().slice(0, 10);
  const note = `Promo package sent to ${rodri} on ${today} (row in Promo Log).`;
  const { tasks: all } = await tasks.loadAll();
  const source = taskId ? all.find((t) => t.taskId === taskId) : null;

  if (source && source.type !== "CONTENT") {
    const reviewer = source.reviewer || rodri;
    const r = await tasks.updateTask(source.taskId, {
      status: "Needs review",
      reviewer,
      output,
      contentLink: source.contentLink || (fromTopic ? "" : url || ""),
      brief: source.brief ? `${source.brief}\n\n${note}` : note,
    }, by, { force: true, notify: !tasks.same(reviewer, rodri) }); // Rodri already gets the package email
    if (r.code !== 200) throw new Error(r.error);
    return { task: r.task, created: false };
  }

  const r = await tasks.createTask({
    client,
    title: `Promo: ${title || source?.title || "new content"}`.slice(0, 200),
    type: "PROMO",
    status: "Needs review",
    owner: rodri,
    reviewer: rodri,
    priority: source?.priority || "Normal",
    brief: `${fromTopic ? `Topic: ${title}` : `Promoting ${url || title}`}\n\n${note}`,
    contentLink: fromTopic ? "" : url || "",
    output,
    parentTask: source ? source.taskId : "",
  }, by, { notify: false });
  if (r.code !== 200) throw new Error(r.error);
  return { task: r.task, created: true };
}

async function notify({ client, title, url, sections, cc, emailHtml, meta = {}, taskId = "", by = "" }) {
  const out = { emailed: false, logged: false, slack: false, warnings: [], task: null };
  const clientName = CLIENTS[client]?.name || client;
  const env0 = process.env;

  // 1. Task Hub first, so the email to Rodri can link straight to the task
  if (env0.GOOGLE_CLIENT_EMAIL && env0.GOOGLE_PRIVATE_KEY && env0.PROMO_SHEET_ID) {
    try {
      const linked = await linkTask({ client, title, url, taskId: String(taskId || "").trim(), by: String(by || "").trim() || "Promo tool", fromTopic: !!meta.fromTopic });
      out.task = { taskId: linked.task.taskId, title: linked.task.title, created: linked.created, url: tasks.taskLink(linked.task.taskId) };
    } catch (err) {
      out.warnings.push(`The Task Hub wasn't updated: ${err.message}`);
    }
  }
  const taskUrl = out.task ? out.task.url : "";
  const subject = `Promo package ready${meta.fromTopic ? " (from a topic)" : ""}: ${clientName} – ${title || "new content"}`.slice(0, 180);
  const ccList = String(cc || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))
    // Only team addresses can be CC'd, so nobody can use this page to email outsiders.
    .filter((s) => ALLOWED_CC_DOMAINS.some((d) => s.toLowerCase().endsWith("@" + d)));
  const env = process.env;

  if (!env.RESEND_API_KEY || !env.PROMO_FROM || !env.RODRI_EMAIL) {
    out.warnings.push("Email isn't set up yet (RESEND_API_KEY, PROMO_FROM and RODRI_EMAIL are needed). Download the HTML and copy the package by hand for now.");
  } else {
    const slug = String(clientName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.PROMO_FROM,
        to: [env.RODRI_EMAIL],
        cc: ccList.length ? ccList : undefined,
        reply_to: ccList[0] || undefined,
        subject,
        html: packageHtml({ clientName, url, sections, taskUrl }),
        text: packageText({ clientName, url, sections, taskUrl }),
        attachments: emailHtml
          ? [{ filename: `${slug || "promo"}-email.html`, content: Buffer.from(emailHtml, "utf8").toString("base64") }]
          : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) out.emailed = true;
    else out.warnings.push(`Email didn't send: ${data.message || res.status}`);
  }

  if (env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY && env.PROMO_SHEET_ID) {
    try {
      await logToSheet([
        new Date().toISOString().slice(0, 10),
        clientName,
        meta.fromTopic ? `Topic: ${title || ""}` : title || "",
        url || "",
        meta.platforms || "",
        meta.subject || "",
        meta.segment || "",
        ccList.join(", "),
        out.emailed ? "Sent to Rodri" : "Not emailed",
        "", // Notes
        "", // Result (Rodri fills in: Used as-is / Light edit / Rewrote / Didn't use)
        "", // What we changed
        out.task ? out.task.taskId : "", // Task ID (links this row to the Task Hub)
      ]);
      out.logged = true;
    } catch (err) {
      out.warnings.push(err.message);
    }
  } else {
    out.warnings.push("The Promo Log sheet isn't connected yet, so this run wasn't logged.");
  }

  if (env.SLACK_WEBHOOK_URL) {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Promo package ready for review (${clientName}): ${title || url}. Check your email, Rodri.` }),
    });
    out.slack = res.ok;
    if (!res.ok) out.warnings.push(`Slack webhook returned ${res.status}.`);
  }
  return out;
}

// ---------- handler ----------

const STEPS = { clients, extract, context, social, email, segment, notify };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  const denied = await checkAccess(event);
  if (denied) return json(denied.statusCode, { error: denied.error, needsCode: denied.statusCode === 401 });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Request body isn't valid JSON." });
  }
  const fn = STEPS[body.step];
  if (!fn) return json(400, { error: `Unknown step: ${body.step}` });
  try {
    return json(200, await fn(body));
  } catch (err) {
    const msg = err.name === "AbortError" ? "The AI step took too long. Run it again or shorten the content." : err.message;
    return json(500, { error: msg });
  }
};
