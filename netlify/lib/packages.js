// netlify/lib/packages.js
// Saves each promo package (posts, email copy and HTML, segment) to a "Packages" tab in the
// Promo Log sheet, so anyone on the team can open it from its task at /package.html#T-0041.
// The tab is created automatically the first time. One row per send; the newest row wins.
// The package is stored as JSON split across the Data columns (a sheet cell holds 50,000 characters).

const { readTab, appendRow, ensureTab } = require("./google");

const TAB = () => process.env.PACKAGES_TAB || "Packages";
const CHUNK = 45000;
const DATA_COLS = 6;
const HEADER = ["Task ID", "Saved at", "Client", "Title", "Content link", "Built by", ...Array.from({ length: DATA_COLS }, (_, i) => `Data ${i + 1}`)];

function siteBase() {
  return (process.env.URL || "https://occdash.netlify.app").replace(/\/$/, "");
}
const packageLink = (taskId) => `${siteBase()}/package.html#${encodeURIComponent(taskId)}`;

// savePackage(taskId, pkg, by) -> link to the package page
async function savePackage(taskId, pkg, by) {
  pkg = { ...pkg, taskId, builtBy: by || "", savedAt: new Date().toISOString() };
  // Keep it under the sheet's limits: drop the HTML before dropping posts
  let data = JSON.stringify(pkg);
  if (data.length > CHUNK * DATA_COLS) data = JSON.stringify({ ...pkg, emailHtml: "", note: "The email HTML was too large to save; it's attached to Rodri's email." });
  if (data.length > CHUNK * DATA_COLS) throw new Error("This package is too large to save in the sheet.");
  const chunks = [];
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
  await ensureTab(TAB(), HEADER);
  await appendRow(TAB(), [pkg.taskId, pkg.savedAt, pkg.clientName || pkg.client, pkg.title || "", pkg.url || "", pkg.builtBy || "", ...chunks]);
  return packageLink(taskId);
}

// Newest package for a task, plus how many versions exist
async function getPackage(taskId) {
  const { header, rows } = await readTab(TAB()).catch(() => ({ header: [], rows: [] }));
  const idCol = header.findIndex((h) => String(h).trim().toLowerCase() === "task id");
  const dataCols = header.map((h, i) => (/^data \d+$/i.test(String(h).trim()) ? i : -1)).filter((i) => i >= 0);
  if (idCol === -1 || !dataCols.length) return null;
  const matches = rows.filter((r) => String(r[idCol] || "").trim() === taskId);
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  try {
    return { ...JSON.parse(dataCols.map((i) => String(last[i] ?? "")).join("")), versions: matches.length };
  } catch (_) {
    throw new Error("The saved package couldn't be read. It may have been edited in the sheet.");
  }
}

module.exports = { savePackage, getPackage, packageLink };
