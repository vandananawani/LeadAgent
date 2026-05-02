"use strict";

const { google } = require("googleapis");

const SHEET_NAME = "Leads";
const DEDUP_COLUMN = "A"; // UniqueKey column
const HEADER_ROW = [
  "UniqueKey",
  "Name",
  "Role",
  "Company",
  "Category",
  "Company Size",
  "Lead Score",
  "Email 1",
  "Email 2",
  "Email 3",
  "Source URL",
  "Date Added",
  "Status",
];

// ─── Auth ──────────────────────────────────────────────────────────────────────
// Handles three formats for GOOGLE_SERVICE_ACCOUNT_JSON:
//   1. Raw JSON string (works locally, breaks on Render due to \n mangling)
//   2. Base64-encoded JSON string (recommended for all cloud deployments)
//   3. Already-parsed object (edge case)
//
// TO ENCODE FOR RENDER:
//   Mac/Linux: base64 -i service-account.json | pbcopy
//   Windows:   [Convert]::ToBase64String([IO.File]::ReadAllBytes("sa.json")) | clip
// Then paste the base64 string as GOOGLE_SERVICE_ACCOUNT_JSON in Render env vars.

function parseServiceAccountJson() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");

  // If it's already an object somehow
  if (typeof raw === "object") return raw;

  const trimmed = raw.trim();

  // Detect base64: no { at start, only base64 chars
  const isBase64 = /^[A-Za-z0-9+/=]+$/.test(trimmed) && !trimmed.startsWith("{");

  let jsonString;
  if (isBase64) {
    try {
      jsonString = Buffer.from(trimmed, "base64").toString("utf8");
      console.log("[Sheets] Decoded service account from base64");
    } catch (e) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON looks like base64 but failed to decode");
    }
  } else {
    jsonString = trimmed;
  }

  let credentials;
  try {
    credentials = JSON.parse(jsonString);
  } catch (e) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. " +
      "For Render/cloud: base64-encode your service account JSON file and use that as the env var value. " +
      `Parse error: ${e.message}`
    );
  }

  // Fix mangled newlines in private_key — cloud providers sometimes escape them
  if (credentials.private_key && typeof credentials.private_key === "string") {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error(
      "Service account JSON is missing client_email or private_key. " +
      "Make sure you downloaded a JSON key (not p12) from Google Cloud Console."
    );
  }

  return credentials;
}

function getAuth() {
  const credentials = parseServiceAccountJson();
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient(auth) {
  return google.sheets({ version: "v4", auth });
}

// ─── Ensure Leads Tab and Headers Exist ───────────────────────────────────────
async function ensureHeaders(sheets, spreadsheetId) {
  await ensureSheetTab(sheets, spreadsheetId, SHEET_NAME, HEADER_ROW);
}

// ─── Fetch Existing Unique Keys (for dedup) ────────────────────────────────────
async function getExistingKeys(sheets, spreadsheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!${DEDUP_COLUMN}2:${DEDUP_COLUMN}10000`,
    });

    const rows = res.data.values || [];
    const keys = new Set(rows.flat().filter(Boolean));
    console.log(`[Sheets] Found ${keys.size} existing lead keys for dedup`);
    return keys;
  } catch (err) {
    console.warn(`[Sheets] Could not fetch existing keys: ${err.message}`);
    return new Set();
  }
}

// ─── Generate Dedup Key ────────────────────────────────────────────────────────
function generateDedupeKey(name, company) {
  const normName = (name || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

  const normCompany = (company || "")
    .toLowerCase()
    .trim()
    .replace(/\b(pvt|ltd|limited|private|inc|llc|llp|group)\b/gi, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  return `${normName}__${normCompany}`;
}

// ─── Append Rows ───────────────────────────────────────────────────────────────
async function appendRows(sheets, spreadsheetId, rows) {
  if (rows.length === 0) return 0;

  const today = new Date().toISOString().split("T")[0];

  const values = rows.map((lead) => [
    generateDedupeKey(lead.name, lead.company), // A: UniqueKey
    lead.name,                                   // B: Name
    lead.role,                                   // C: Role
    lead.company,                                // D: Company
    lead.category,                               // E: Category
    lead.company_size,                           // F: Company Size
    lead.lead_score,                             // G: Lead Score
    lead.email_predictions[0] || "",             // H: Email 1
    lead.email_predictions[1] || "",             // I: Email 2
    lead.email_predictions[2] || "",             // J: Email 3
    lead.source_url,                             // K: Source URL
    today,                                       // L: Date Added
    "New",                                       // M: Status
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return rows.length;
}

// ─── Main Export: Save Leads ───────────────────────────────────────────────────
async function saveLeads(leads) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID is not set");

  console.log(`[Sheets] Connecting to Google Sheets...`);

  const auth = getAuth();
  const sheets = getSheetsClient(auth);

  // Ensure the sheet and headers exist
  await ensureHeaders(sheets, spreadsheetId);

  // Fetch existing keys for deduplication
  const existingKeys = await getExistingKeys(sheets, spreadsheetId);

  // Filter out duplicates
  const newLeads = leads.filter((lead) => {
    const key = generateDedupeKey(lead.name, lead.company);
    if (existingKeys.has(key)) {
      console.log(`[Sheets] Skipping duplicate: ${lead.name} @ ${lead.company}`);
      return false;
    }
    return true;
  });

  console.log(
    `[Sheets] ${leads.length} leads → ${newLeads.length} new (${leads.length - newLeads.length} duplicates removed)`
  );

  if (newLeads.length === 0) {
    console.log("[Sheets] Nothing to insert.");
    return 0;
  }

  // Insert in batches of 50 to avoid API limits
  const BATCH_SIZE = 50;
  let totalInserted = 0;

  for (let i = 0; i < newLeads.length; i += BATCH_SIZE) {
    const batch = newLeads.slice(i, i + BATCH_SIZE);
    const inserted = await appendRows(sheets, spreadsheetId, batch);
    totalInserted += inserted;
    console.log(`[Sheets] Inserted batch: ${inserted} rows (total: ${totalInserted})`);

    if (i + BATCH_SIZE < newLeads.length) {
      await sleep(1000); // Brief pause between batch inserts
    }
  }

  console.log(`[Sheets] ✅ Done. ${totalInserted} new leads saved.`);
  return totalInserted;
}

// ─── Ensure Sheet Tab Exists ──────────────────────────────────────────────────
// Checks spreadsheet metadata for a tab by title. Creates it with headers if
// missing. Returns a sheets client + confirmed tab name for callers to use.
async function ensureSheetTab(sheets, spreadsheetId, tabTitle, headers) {
  // Fetch spreadsheet metadata to check existing sheet titles
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTitles = (meta.data.sheets || []).map(
    (s) => s.properties.title
  );

  if (!existingTitles.includes(tabTitle)) {
    console.log(`[Sheets] Creating tab "${tabTitle}"...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabTitle } } }],
      },
    });
    // Write headers on the new tab
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabTitle}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
    console.log(`[Sheets] Tab "${tabTitle}" created with headers`);
  }
}

// ─── Log Run to Sheet ──────────────────────────────────────────────────────────
async function logRun(stats) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return;

  const LOG_TAB = "RunLog";
  const LOG_HEADERS = [
    "Date", "Raw Scraped", "After AI", "After Dedup",
    "Saved", "Duration (s)", "Status",
  ];

  const row = [[
    stats.date,
    stats.rawCount,
    stats.afterAI,
    stats.afterDedup,
    stats.saved,
    stats.durationSeconds,
    stats.status,
  ]];

  try {
    const auth = getAuth();
    const sheets = getSheetsClient(auth);

    // Try appending directly first — fastest path when tab already exists
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${LOG_TAB}!A1`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: row },
      });
      console.log(`[Sheets] Run logged → ${LOG_TAB}`);
      return;
    } catch (appendErr) {
      // Tab doesn't exist yet — create it then retry
      const msg = appendErr.message || "";
      const isNotFound =
        msg.includes("Unable to parse range") ||
        msg.includes("not found") ||
        msg.includes("Requested entity") ||
        appendErr.response?.status === 400 ||
        appendErr.response?.status === 404;

      if (!isNotFound) throw appendErr; // Different error — rethrow
    }

    // Create the tab with headers
    console.log(`[Sheets] Creating ${LOG_TAB} tab...`);
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: LOG_TAB } } }],
        },
      });
    } catch (createErr) {
      // Tab might already exist (race condition) — ignore duplicate error
      if (!createErr.message?.includes("already exists")) throw createErr;
    }

    // Write headers
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${LOG_TAB}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [LOG_HEADERS] },
    });

    // Now append the data row
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${LOG_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: row },
    });

    console.log(`[Sheets] Run logged → ${LOG_TAB} (tab created)`);
  } catch (err) {
    console.warn(`[Sheets] Could not write run log: ${err.message}`);
  }
}

// ─── Check If Today's Run Already Happened ────────────────────────────────────
async function hasRunToday() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return false;

  const today = new Date().toISOString().split("T")[0];

  try {
    const auth = getAuth();
    const sheets = getSheetsClient(auth);

    // Check tab exists first — avoid confusing "entity not found" errors
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const titles = (meta.data.sheets || []).map((s) => s.properties.title);
    if (!titles.includes("RunLog")) {
      console.log("[Sheets] RunLog tab does not exist yet — assuming no run today");
      return false;
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "RunLog!A2:G1000",
    });

    const rows = res.data.values || [];
    const todaySuccess = rows.some(
      (row) => row[0] === today && row[6] === "SUCCESS"
    );

    console.log(
      todaySuccess
        ? `[Sheets] RunLog: today (${today}) already has a successful run`
        : `[Sheets] RunLog: no successful run found for today (${today})`
    );

    return todaySuccess;
  } catch (err) {
    console.log(`[Sheets] hasRunToday check failed (${err.message}) — assuming no run today`);
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { saveLeads, logRun, hasRunToday, generateDedupeKey };
