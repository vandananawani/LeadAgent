"use strict";

const { scrapeLeads } = require("./apify");
const { processAllLeads } = require("./gemini");
const { saveLeads, logRun } = require("./sheets");

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

    // ── STEP 2: Process with Gemini ────────────────────────────
    console.log("[Step 2/3] Processing leads with Gemini AI...");
    const processedLeads = await processAllLeads(rawLeads, 20);
    stats.afterAI = processedLeads.length;

    if (processedLeads.length === 0) {
      console.warn("[Pipeline] Gemini returned 0 qualified leads. Aborting.");
      stats.status = "EMPTY_AI";
      await logRun({ ...stats, durationSeconds: elapsed(startTime) });
      return stats;
    }

    // Sort by lead score descending
    processedLeads.sort((a, b) => b.lead_score - a.lead_score);

    console.log(`[Step 2/3] ✅ ${processedLeads.length} qualified leads after AI filtering\n`);
    printLeadSummary(processedLeads);

    // ── STEP 3: Save to Google Sheets ─────────────────────────
    console.log("[Step 3/3] Saving to Google Sheets...");
    const saved = await saveLeads(processedLeads);
    stats.afterDedup = processedLeads.length;
    stats.saved = saved;
    stats.status = "SUCCESS";

    console.log(`[Step 3/3] ✅ ${saved} new leads saved to Google Sheets\n`);

  } catch (err) {
    console.error(`\n[Pipeline] ❌ Fatal error: ${err.message}`);
    console.error(err.stack);
    stats.status = `ERROR: ${err.message.slice(0, 100)}`;
  }

  stats.durationSeconds = elapsed(startTime);

  // ── Log run stats ──────────────────────────────────────────
  try {
    await logRun(stats);
  } catch (logErr) {
    console.warn(`[Pipeline] Could not write run log: ${logErr.message}`);
  }

  printFinalSummary(stats);
  return stats;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function elapsed(startTime) {
  return Math.floor((Date.now() - startTime) / 1000);
}

function printLeadSummary(leads) {
  const cfoCount = leads.filter((l) => l.category === "CFO").length;
  const fdmCount = leads.filter((l) => l.category === "Finance Decision Maker").length;
  const avgScore = (leads.reduce((s, l) => s + l.lead_score, 0) / leads.length).toFixed(1);
  const highScore = leads.filter((l) => l.lead_score >= 8).length;

  console.log("─".repeat(40));
  console.log(`  CFOs:                    ${cfoCount}`);
  console.log(`  Finance Decision Makers: ${fdmCount}`);
  console.log(`  Avg lead score:          ${avgScore}`);
  console.log(`  High-quality (>=8):      ${highScore}`);
  console.log("─".repeat(40));

  // Print top 5 leads
  console.log("\n  TOP LEADS:");
  leads.slice(0, 5).forEach((lead, i) => {
    console.log(
      `  ${i + 1}. [${lead.lead_score}/10] ${lead.name} — ${lead.role} @ ${lead.company}`
    );
  });
  console.log("");
}

function printFinalSummary(stats) {
  console.log("\n" + "=".repeat(60));
  console.log("[Pipeline] RUN COMPLETE");
  console.log("=".repeat(60));
  console.log(`  Status:          ${stats.status}`);
  console.log(`  Raw scraped:     ${stats.rawCount}`);
  console.log(`  After AI filter: ${stats.afterAI}`);
  console.log(`  New leads saved: ${stats.saved}`);
  console.log(`  Duration:        ${stats.durationSeconds}s`);
  console.log("=".repeat(60) + "\n");
}

module.exports = { runPipeline };
