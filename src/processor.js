"use strict";

const { scrapeLeads } = require("./apify");
const { saveRawLeads, logRun } = require("./sheets");

// ─── Parse Raw Lead from Apify Result ─────────────────────────────────────────
// Extracts name, role, company from the Google search result title/snippet
function parseRawLead(raw) {
  const title = raw.title || "";
  const url = raw.url || "";
  const snippet = raw.description || "";

  // Title format examples:
  // "Rajesh Mehta - CFO at Infra Solutions | LinkedIn"
  // "Priya Shah – Finance Head, ABC Industries | LinkedIn"
  // "VP Finance at XYZ Group - LinkedIn"

  let name = "Unknown";
  let role = "Finance Professional";
  let company = "Unknown";

  // Strip " | LinkedIn" and " - LinkedIn" from end
  const cleanTitle = title
    .replace(/\s*[\|–-]\s*LinkedIn.*$/i, "")
    .replace(/\s*on LinkedIn.*$/i, "")
    .trim();

  // Pattern: "Name - Role at Company" or "Name – Role, Company"
  const dashMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (dashMatch) {
    name = dashMatch[1].trim();
    role = dashMatch[2].trim();
    company = dashMatch[3].trim();
  } else {
    // Pattern: "Name - Role | Company" (pipe separator)
    const pipeMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s*[\|,]\s*(.+)$/i);
    if (pipeMatch) {
      name = pipeMatch[1].trim();
      role = pipeMatch[2].trim();
      company = pipeMatch[3].trim();
    } else {
      // Fallback: treat whole title as name, extract role from snippet
      name = cleanTitle.split(/[-–|]/)[0].trim() || "Unknown";
      // Try to find role in snippet
      const roleMatch = snippet.match(/\b(CFO|Chief Financial Officer|Finance Head|VP Finance|Director Finance|Finance Director|Head of Finance|Finance Controller|Group CFO)\b/i);
      if (roleMatch) role = roleMatch[1];
      // Try to find company in snippet
      const companyMatch = snippet.match(/(?:at|@)\s+([A-Z][^.]+(?:Ltd|Limited|Pvt|Group|Industries|Holdings|Inc)?)/);
      if (companyMatch) company = companyMatch[1].trim();
    }
  }

  // Clean up company — remove trailing punctuation
  company = company.replace(/[.,|].*$/, "").trim();

  // Determine role category
  const titleLower = (role + " " + title).toLowerCase();
  let category = "Finance Professional";
  if (/\bcfo\b|chief financial/.test(titleLower)) category = "CFO";
  else if (/vp finance|vice president finance/.test(titleLower)) category = "VP Finance";
  else if (/finance head|head of finance/.test(titleLower)) category = "Finance Head";
  else if (/finance director|director finance/.test(titleLower)) category = "Finance Director";
  else if (/finance controller|controller/.test(titleLower)) category = "Finance Controller";

  return {
    name,
    role,
    company,
    category,
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

