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
//   SLACK_WEBHOOK_URL     optional

const crypto = require("crypto");
const MODEL = "claude-haiku-4-5-20251001"; // same model as agent.js

// ---------- client roster ----------
// rules: what the copy must respect.  brand: colors/logo for the HTML email (OverCoffee navy/gold if empty).
// brand fields: color (header + headline), accent (button), buttonText (text on button), logo (https URL, ~40px tall)
const CLIENT_GROUPS = [
  {
    label: "OverCoffee clients",
    clients: [
      { code: "TCC", name: "Texas Cannabis Clinic", rules: "Medical cannabis clinic. No health, cure or treatment-outcome claims. No imagery of consumption. Meta and Instagram restrict cannabis promotion, so keep social posts educational and about the clinic and its process, never the product." },
      { code: "H&S", name: "Heart & Soul Integrative Medicine", rules: "Healthcare practice. No promised outcomes or medical claims; educational, warm, trustworthy tone." },
      { code: "Cody", name: "Cody Young Septic", rules: "Local home-services business. Plain-spoken, practical, helpful; lead with the homeowner's problem." },
      { code: "Horse + Bow", name: "Horse + Bow" },
      { code: "RJD", name: "Rachel Jackson Design" },
      { code: "Continental", name: "Continental" },
      { code: "Feast for a King", name: "Feast for a King" },
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
      { code: "Barworks", name: "Barworks" },
    ],
  },
  {
    label: "Internal",
    clients: [{ code: "OCC", name: "OverCoffee Consulting", rules: "Our own agency. Friendly, expert, no jargon; small businesses are the audience.", brand: { color: "#191a2e", accent: "#c9a84c", buttonText: "#191a2e" } }],
  },
];

const CLIENTS = Object.fromEntries(CLIENT_GROUPS.flatMap((g) => g.clients.map((c) => [c.code, c])));
// Email domains that may be CC'd on a package (keeps the page from being usable to email anyone else).
const ALLOWED_CC_DOMAINS = ["overcoffeeconsulting.com"];

const DEFAULT_BRAND = { color: "#191a2e", accent: "#c9a84c", buttonText: "#191a2e", logo: "" };

// ---------- helpers ----------

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function clientBlock(code) {
  const c = CLIENTS[code] || { name: code };
  return [`Client: ${c.name}`, c.rules ? `Rules: ${c.rules}` : ""].filter(Boolean).join("\n");
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

async function clients() {
  return { groups: CLIENT_GROUPS.map((g) => ({ label: g.label, clients: g.clients.map(({ code, name }) => ({ code, name })) })) };
}

// 1. Read the content: a URL (blog post, landing page) or pasted text.
async function extract({ url, text }) {
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
async function social({ client, content, platform, goal, language }) {
  const system =
    "You are OverCoffee Consulting's social media writer. You turn one piece of client content into platform-native posts that drive people to it. You never invent facts, prices, dates, offers or statistics that aren't in the content.";
  const user = `${clientBlock(client)}
${languageLine(language)}
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
async function email({ client, content, posts, goal, language }) {
  const system =
    "You are OverCoffee Consulting's email marketer. You write short promotional emails that send subscribers to a client's new content. You never invent facts, offers, prices or dates that aren't in the content.";
  const angle = (posts || [])
    .slice(0, 2)
    .map((p) => `${p.platform}: ${String(p.variations?.[0]?.copy || "").slice(0, 300)}`)
    .join("\n");
  const user = `${clientBlock(client)}
${languageLine(language)}
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
  const c = CLIENTS[client] || { name: client };
  return { ...copy, cta_url: copy.cta_url || content.url || "", brand: { ...DEFAULT_BRAND, ...(c.brand || {}), name: c.name } };
}

// 4. Who should get it. Grounded in the client's real segments when the team pastes them in.
async function segment({ client, content, email: mail, goal, knownSegments }) {
  const system =
    "You are OverCoffee Consulting's CRM strategist. You recommend which audience segment should receive a promo email. You never invent list sizes, open rates or other numbers.";
  const user = `${clientBlock(client)}
Goal: ${goal || "get subscribers to read the content"}
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
function packageHtml({ clientName, url, sections }) {
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
<p style="font:16px/1.5 Arial,sans-serif;color:#555;margin-top:32px">Update the status in the Promo Log sheet once it's scheduled. Reply to this email with changes.</p>
</div>`;
}

function packageText({ clientName, url, sections }) {
  return [
    `Hi Rodri, a promo package for ${clientName} is ready for your review. Nothing has been posted or sent yet. The ready-to-paste HTML email is attached.`,
    url ? `Content: ${url}` : "",
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
  return data.access_token;
}

async function logToSheet(row) {
  const tab = process.env.PROMO_SHEET_TAB || "Promo Log";
  const token = await googleToken();
  const range = encodeURIComponent(`${tab}!A:J`);
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

async function notify({ client, title, url, sections, cc, emailHtml, meta = {} }) {
  const out = { emailed: false, logged: false, slack: false, warnings: [] };
  const clientName = CLIENTS[client]?.name || client;
  const subject = `Promo package ready: ${clientName} – ${title || "new content"}`.slice(0, 180);
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
        html: packageHtml({ clientName, url, sections }),
        text: packageText({ clientName, url, sections }),
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
        title || "",
        url || "",
        meta.platforms || "",
        meta.subject || "",
        meta.segment || "",
        ccList.join(", "),
        out.emailed ? "Sent to Rodri" : "Not emailed",
        "",
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

const STEPS = { clients, extract, social, email, segment, notify };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
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
