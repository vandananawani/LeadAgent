"use strict";

const axios = require("axios");
const { scrapeLeads } = require("./apify");
const { saveRawLeads, logRun } = require("./sheets");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// ─── Email Prediction ──────────────────────────────────────────────────────────
function predictEmails(name, company) {
  if (!name || name === "Unknown" || !company || company === "Unknown") return [];
  const cleanName = name
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|CA|CFA|CPA|MBA)\b\.?/gi, "")
    .trim();
  const parts = cleanName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const first = parts[0].toLowerCase().replace(/[^a-z]/g, "");
  const last = parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, "");
  const firstInitial = first[0] || "";
  const domain = guessDomain(company);
  if (!domain) return [];
  return [
    `${first}.${last}@${domain}`,
    `${firstInitial}${last}@${domain}`,
    `${first}@${domain}`,
  ];
}

function guessDomain(company) {
  if (!company || company === "Unknown") return null;
  const clean = company
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|group|holdings|industries|enterprises|solutions|services|technologies|tech|india|global|international)\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "");
  if (!clean || clean.length < 2) return null;
  return `${clean}.com`;
}

// ─── Single Gemini Call: Estimate Company Size for ALL companies ───────────────
// Sends ONE request with all unique company names.
// Returns a Map of companyName → { size, turnover }
async function estimateCompanySizes(companies) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn("[Gemini] GEMINI_API_KEY not set — skipping size estimation");
    return new Map();
  }

  // Deduplicate companies
  const unique = [...new Set(companies.filter(c => c && c !== "Unknown"))];
  if (unique.length === 0) return new Map();

  console.log(`[Gemini] Estimating size for ${unique.length} unique companies (1 API call)...`);

  const companyList = unique.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const prompt = `You are a business intelligence assistant. For each Indian company below, estimate:
1. Employee count range
2. Approximate annual turnover in INR crores

Use these signals: company name keywords (Pvt Ltd = SME, Group/Holdings = large), industry context, and general knowledge of Indian companies.

Companies:
${companyList}

RESPOND ONLY WITH THIS JSON — no explanation, no markdown:
{
  "companies": [
    {"name": "exact company name from list", "size": "50-200 employees", "turnover": "10-50 Cr"},
    ...
  ]
}

Size categories: "1-50 employees", "50-200 employees", "200-500 employees", "500-2000 employees", "2000-10000 employees", "10000+ employees"
Turnover categories: "<10 Cr", "10-50 Cr", "50-200 Cr", "200-500 Cr", "500-2000 Cr", "2000-5000 Cr", "5000+ Cr", "Listed/Large Cap"
If unknown, use "Unknown" for both.`;

  try {
    const response = await axios.post(
      `${GEMINI_URL}?key=${key}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      },
      { headers: { "Content-Type": "application/json" }, timeout: 60000 }
    );

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let parsed;
    // Try direct parse
    try { parsed = JSON.parse(cleaned); }
    catch {
      // Try extracting JSON block
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }

    const result = new Map();
    for (const item of parsed?.companies || []) {
      if (item.name) result.set(item.name.trim(), {
        size: item.size || "Unknown",
        turnover: item.turnover || "Unknown",
      });
    }

    console.log(`[Gemini] Got size estimates for ${result.size} companies ✅`);
    return result;

  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    console.warn(`[Gemini] Size estimation failed (${status}): ${msg}`);
    console.warn("[Gemini] Continuing without size data...");
    return new Map();
  }
}

// ─── Parse Raw Lead from Apify Result ─────────────────────────────────────────
function parseRawLead(raw) {
  const title = raw.title || "";
  const url = raw.url || "";
  const snippet = raw.description || "";

  let name = "Unknown";
  let role = "Finance Professional";
  let company = "Unknown";

  const cleanTitle = title
    .replace(/\s*[\|–-]\s*LinkedIn.*$/i, "")
    .replace(/\s*on LinkedIn.*$/i, "")
    .trim();

  const dashMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (dashMatch) {
    name = dashMatch[1].trim();
    role = dashMatch[2].trim();
    company = dashMatch[3].trim();
  } else {
    const pipeMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s*[\|,]\s*(.+)$/i);
    if (pipeMatch) {
      name = pipeMatch[1].trim();
      role = pipeMatch[2].trim();
      company = pipeMatch[3].trim();
    } else {
      name = cleanTitle.split(/[-–|]/)[0].trim() || "Unknown";
      const roleMatch = snippet.match(/\b(CFO|Chief Financial Officer|Finance Head|VP Finance|Director Finance|Finance Director|Head of Finance|Finance Controller|Group CFO)\b/i);
      if (roleMatch) role = roleMatch[1];
      const companyMatch = snippet.match(/(?:at|@)\s+([A-Z][^.]+(?:Ltd|Limited|Pvt|Group|Industries|Holdings|Inc)?)/);
      if (companyMatch) company = companyMatch[1].trim();
    }
  }

  company = company.replace(/[.,|].*$/, "").trim();

  const titleLower = (role + " " + title).toLowerCase();
  let category = "Finance Professional";
  if (/\bcfo\b|chief financial/.test(titleLower)) category = "CFO";
  else if (/vp finance|vice president finance/.test(titleLower)) category = "VP Finance";
  else if (/finance head|head of finance/.test(titleLower)) category = "Finance Head";
  else if (/finance director|director finance/.test(titleLower)) category = "Finance Director";
  else if (/finance controller|controller/.test(titleLower)) category = "Finance Controller";

  const emails = predictEmails(name, company);

  return {
    name,
    role,
    company,
    category,
    company_size: "Unknown",  // filled in after Gemini call
    turnover: "Unknown",      // filled in after Gemini call
    email1: emails[0] || "",
    email2: emails[1] || "",
    email3: emails[2] || "",
    source_url: url,
    snippet: snippet.slice(0, 200),
  };
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────────
async function runPipeline() {
  const startTime = Date.now();
  const location = process.env.TARGET_LOCATION || "India";
  const today = new Date().toISOString().split("T")[0];

  const stats = {
    date: today,
    rawCount: 0,
    afterAI: 0,
    afterDedup: 0,
    saved: 0,
    durationSeconds: 0,
    status: "FAILED",
  };

  console.log("=".repeat(60));
  console.log(`[Pipeline] Starting CFO lead generation — ${today}`);
  console.log(`[Pipeline] Target location: ${location}`);
  console.log("=".repeat(60));

  try {
    // ── STEP 1: Scrape with Apify ──────────────────────────────
    console.log("\n[Step 1/3] Scraping leads from Google via Apify...");
    const rawLeads = await scrapeLeads(location);
    stats.rawCount = rawLeads.length;

    if (rawLeads.length === 0) {
      console.warn("[Pipeline] No raw leads returned from Apify. Aborting.");
      stats.status = "EMPTY_SCRAPE";
      await logRun({ ...stats, durationSeconds: elapsed(startTime) });
      return stats;
    }

    console.log(`[Step 1/3] ✅ ${rawLeads.length} raw leads scraped\n`);

    // ── STEP 2: Parse leads + estimate company sizes ───────────
    console.log("[Step 2/3] Parsing leads and estimating company sizes...");
    const parsedLeads = rawLeads.map(parseRawLead);
    stats.afterAI = parsedLeads.length;

    // Single Gemini call for all company sizes
    const companies = parsedLeads.map(l => l.company);
    const sizeMap = await estimateCompanySizes(companies);

    // Attach size + turnover to each lead
    let enriched = 0;
    for (const lead of parsedLeads) {
      const info = sizeMap.get(lead.company);
      if (info) {
        lead.company_size = info.size;
        lead.turnover = info.turnover;
        enriched++;
      }
    }
    console.log(`[Step 2/3] ✅ ${enriched}/${parsedLeads.length} leads enriched with size data\n`);

    // Print sample
    console.log("  SAMPLE LEADS:");
    parsedLeads.slice(0, 5).forEach((lead, i) => {
      console.log(`  ${i + 1}. ${lead.name} — ${lead.role} @ ${lead.company} [${lead.turnover}]`);
    });
    console.log("");

    // ── STEP 3: Save to Google Sheets ─────────────────────────
    console.log("[Step 3/3] Saving to Google Sheets...");
    const saved = await saveRawLeads(parsedLeads);
    stats.afterDedup = parsedLeads.length;
    stats.saved = saved;
    stats.status = "SUCCESS";

    console.log(`[Step 3/3] ✅ ${saved} new leads saved to Google Sheets\n`);

  } catch (err) {
    console.error(`\n[Pipeline] ❌ Fatal error: ${err.message}`);
    console.error(err.stack);
    stats.status = `ERROR: ${err.message.slice(0, 100)}`;
  }

  stats.durationSeconds = elapsed(startTime);

  try {
    await logRun(stats);
  } catch (logErr) {
    console.warn(`[Pipeline] Could not write run log: ${logErr.message}`);
  }

  printFinalSummary(stats);
  return stats;
}

function elapsed(startTime) {
  return Math.floor((Date.now() - startTime) / 1000);
}

function printFinalSummary(stats) {
  console.log("\n" + "=".repeat(60));
  console.log("[Pipeline] RUN COMPLETE");
  console.log("=".repeat(60));
  console.log(`  Status:      ${stats.status}`);
  console.log(`  Raw scraped: ${stats.rawCount}`);
  console.log(`  Parsed:      ${stats.afterAI}`);
  console.log(`  Saved:       ${stats.saved}`);
  console.log(`  Duration:    ${stats.durationSeconds}s`);
  console.log("=".repeat(60) + "\n");
}

module.exports = { runPipeline };


// ─── Email Prediction ──────────────────────────────────────────────────────────
// Generates 3 probable professional email formats from name + company.
// No API needed — pure pattern matching. ~40-60% accuracy in practice.
function predictEmails(name, company) {
  if (!name || name === "Unknown" || !company || company === "Unknown") return [];

  // Clean name — remove titles, extra spaces
  const cleanName = name
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|CA|CFA|CPA|MBA)\b\.?/gi, "")
    .trim();

  const parts = cleanName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];

  const first = parts[0].toLowerCase().replace(/[^a-z]/g, "");
  const last = parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, "");
  const firstInitial = first[0] || "";

  // Guess domain from company name
  const domain = guessDomain(company);
  if (!domain) return [];

  return [
    `${first}.${last}@${domain}`,
    `${firstInitial}${last}@${domain}`,
    `${first}@${domain}`,
  ].filter(Boolean);
}

function guessDomain(company) {
  if (!company || company === "Unknown") return null;

  // Remove common suffixes and clean
  const clean = company
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|group|holdings|industries|enterprises|solutions|services|technologies|tech|india|global|international)\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "");

  if (!clean || clean.length < 2) return null;
  return `${clean}.com`;
}

// ─── Parse Raw Lead from Apify Result ─────────────────────────────────────────
function parseRawLead(raw) {
  const title = raw.title || "";
  const url = raw.url || "";
  const snippet = raw.description || "";

  let name = "Unknown";
  let role = "Finance Professional";
  let company = "Unknown";

  // Strip " | LinkedIn" and " - LinkedIn" from end
  const cleanTitle = title
    .replace(/\s*[\|–-]\s*LinkedIn.*$/i, "")
    .replace(/\s*on LinkedIn.*$/i, "")
    .trim();

  // Pattern: "Name - Role at Company"
  const dashMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (dashMatch) {
    name = dashMatch[1].trim();
    role = dashMatch[2].trim();
    company = dashMatch[3].trim();
  } else {
    // Pattern: "Name - Role | Company"
    const pipeMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s*[\|,]\s*(.+)$/i);
    if (pipeMatch) {
      name = pipeMatch[1].trim();
      role = pipeMatch[2].trim();
      company = pipeMatch[3].trim();
    } else {
      name = cleanTitle.split(/[-–|]/)[0].trim() || "Unknown";
      const roleMatch = snippet.match(/\b(CFO|Chief Financial Officer|Finance Head|VP Finance|Director Finance|Finance Director|Head of Finance|Finance Controller|Group CFO)\b/i);
      if (roleMatch) role = roleMatch[1];
      const companyMatch = snippet.match(/(?:at|@)\s+([A-Z][^.]+(?:Ltd|Limited|Pvt|Group|Industries|Holdings|Inc)?)/);
      if (companyMatch) company = companyMatch[1].trim();
    }
  }

  // Clean up
  company = company.replace(/[.,|].*$/, "").trim();

  // Category
  const titleLower = (role + " " + title).toLowerCase();
  let category = "Finance Professional";
  if (/\bcfo\b|chief financial/.test(titleLower)) category = "CFO";
  else if (/vp finance|vice president finance/.test(titleLower)) category = "VP Finance";
  else if (/finance head|head of finance/.test(titleLower)) category = "Finance Head";
  else if (/finance director|director finance/.test(titleLower)) category = "Finance Director";
  else if (/finance controller|controller/.test(titleLower)) category = "Finance Controller";

  // Predict emails
  const emails = predictEmails(name, company);

  return {
    name,
    role,
    company,
    category,
    email1: emails[0] || "",
    email2: emails[1] || "",
    email3: emails[2] || "",
    source_url: url,
    snippet: snippet.slice(0, 200),
  };
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────────
async function runPipeline() {
  const startTime = Date.now();
  const location = process.env.TARGET_LOCATION || "India";
  const today = new Date().toISOString().split("T")[0];

  const stats = {
    date: today,
    rawCount: 0,
    afterAI: 0,
    afterDedup: 0,
    saved: 0,
    durationSeconds: 0,
    status: "FAILED",
  };

  console.log("=".repeat(60));
  console.log(`[Pipeline] Starting CFO lead generation — ${today}`);
  console.log(`[Pipeline] Target location: ${location}`);
  console.log("[Pipeline] Mode: Direct save (no AI processing)");
  console.log("=".repeat(60));

  try {
    // ── STEP 1: Scrape with Apify ──────────────────────────────
    console.log("\n[Step 1/2] Scraping leads from Google via Apify...");
    const rawLeads = await scrapeLeads(location);
    stats.rawCount = rawLeads.length;

    if (rawLeads.length === 0) {
      console.warn("[Pipeline] No raw leads returned from Apify. Aborting.");
      stats.status = "EMPTY_SCRAPE";
      await logRun({ ...stats, durationSeconds: elapsed(startTime) });
      return stats;
    }

    console.log(`[Step 1/2] ✅ ${rawLeads.length} raw leads scraped\n`);

    // ── STEP 2: Parse + Save directly to Sheets ───────────────
    console.log("[Step 2/2] Parsing and saving to Google Sheets...");

    const parsedLeads = rawLeads.map(parseRawLead);
    stats.afterAI = parsedLeads.length;

    // Print sample
    console.log("\n  SAMPLE LEADS:");
    parsedLeads.slice(0, 5).forEach((lead, i) => {
      console.log(`  ${i + 1}. ${lead.name} — ${lead.role} @ ${lead.company}`);
    });
    console.log("");

    const saved = await saveRawLeads(parsedLeads);
    stats.afterDedup = parsedLeads.length;
    stats.saved = saved;
    stats.status = "SUCCESS";

    console.log(`[Step 2/2] ✅ ${saved} new leads saved to Google Sheets\n`);

  } catch (err) {
    console.error(`\n[Pipeline] ❌ Fatal error: ${err.message}`);
    console.error(err.stack);
    stats.status = `ERROR: ${err.message.slice(0, 100)}`;
  }

  stats.durationSeconds = elapsed(startTime);

  try {
    await logRun(stats);
  } catch (logErr) {
    console.warn(`[Pipeline] Could not write run log: ${logErr.message}`);
  }

  printFinalSummary(stats);
  return stats;
}

function elapsed(startTime) {
  return Math.floor((Date.now() - startTime) / 1000);
}

function printFinalSummary(stats) {
  console.log("\n" + "=".repeat(60));
  console.log("[Pipeline] RUN COMPLETE");
  console.log("=".repeat(60));
  console.log(`  Status:      ${stats.status}`);
  console.log(`  Raw scraped: ${stats.rawCount}`);
  console.log(`  Parsed:      ${stats.afterAI}`);
  console.log(`  Saved:       ${stats.saved}`);
  console.log(`  Duration:    ${stats.durationSeconds}s`);
  console.log("=".repeat(60) + "\n");
}

module.exports = { runPipeline };

