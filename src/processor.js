"use strict";

const { scrapeLeads } = require("./scraper");
const { saveRawLeads, logRun } = require("./sheets");

// ─── India Detection ───────────────────────────────────────────────────────────
// Detects whether a lead is India-based from snippet, title, and location signals.
const INDIA_KEYWORDS = [
  "india", "indian", "mumbai", "delhi", "new delhi", "bangalore", "bengaluru",
  "hyderabad", "chennai", "pune", "kolkata", "ahmedabad", "surat", "jaipur",
  "lucknow", "kanpur", "nagpur", "indore", "thane", "bhopal", "visakhapatnam",
  "pimpri", "patna", "vadodara", "ghaziabad", "ludhiana", "agra", "nashik",
  "faridabad", "meerut", "rajkot", "kalyan", "vasai", "varanasi", "srinagar",
  "aurangabad", "dhanbad", "amritsar", "navi mumbai", "allahabad", "howrah",
  "ranchi", "coimbatore", "jabalpur", "gwalior", "vijayawada", "jodhpur",
  "madurai", "raipur", "kota", "gurgaon", "gurugram", "noida", "chandigarh",
  "trivandrum", "thiruvananthapuram", "kochi", "cochin", "bhubaneswar",
  "pvt ltd", "private limited", "pvt. ltd", "ltd india", "india pvt",
  "nse", "bse", "sensex", "nifty", "sebi", "rbi", "inr", "crore",
  "rupee", "indian rupee", "tata", "reliance", "infosys", "wipro", "hcl",
  "mahindra", "bajaj", "birla", "adani", "ambani"
];

const NON_INDIA_KEYWORDS = [
  "singapore", "dubai", "uae", "united arab emirates", "usa", "united states",
  "uk", "united kingdom", "london", "new york", "california", "australia",
  "canada", "malaysia", "hong kong", "germany", "france", "netherlands",
  "bahrain", "kuwait", "qatar", "saudi arabia", "riyadh", "abu dhabi",
  "san francisco", "chicago", "los angeles", "toronto",
  "sydney", "melbourne", "johannesburg", "kenya", "nigeria", "bangladesh",
  "pakistan", "sri lanka", "nepal", "doha"
];

function isIndiaLead(name, company, role, snippet, title) {
  const allText = [name, company, role, snippet, title]
    .join(" ")
    .toLowerCase();

  // Hard exclude: if strong non-India signals present
  for (const kw of NON_INDIA_KEYWORDS) {
    if (allText.includes(kw)) return false;
  }

  // Accept: if any India signal present
  for (const kw of INDIA_KEYWORDS) {
    if (allText.includes(kw)) return true;
  }

  // Ambiguous: include (search queries already target India)
  return true;
}

// ─── Company Name Sanitizer ────────────────────────────────────────────────────
function sanitizeCompany(raw) {
  if (!raw) return "Unknown";
  return raw
    .trim()
    .replace(/\s*[|–\-]+\s*$/, "")
    .replace(/\s*[-–|]\s*LinkedIn.*$/i, "")
    .replace(/\s*on LinkedIn.*$/i, "")
    .replace(/[.,]+$/, "")
    .trim() || "Unknown";
}

// ─── Company Extraction ────────────────────────────────────────────────────────
// Extracts the best possible company name from the title and snippet.
function extractCompany(cleanTitle, snippet) {
  // Pattern 1: "Name - Role at Company Name"
  const atPattern = cleanTitle.match(/^.+?\s*[-–]\s*.+?\s+(?:at|@)\s+(.+)$/i);
  if (atPattern) return sanitizeCompany(atPattern[1]);

  // Pattern 2: "Name - Role | Company" or "Name - Role , Company"
  const pipePattern = cleanTitle.match(/^.+?\s*[-–]\s*.+?\s*[|,]\s*(.+)$/i);
  if (pipePattern) return sanitizeCompany(pipePattern[1]);

  // Pattern 3: snippet "at <Company>" with Indian company suffixes
  const snippetAt = snippet.match(
    /\bat\s+([A-Z][A-Za-z0-9&\s'.,-]{2,60}?(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Ltd\.?|Limited|Group|Holdings|Industries|Enterprises|Solutions|Services|Technologies|Tech|Corp\.?|Inc\.?|LLP|LLC)?)\b/
  );
  if (snippetAt) return sanitizeCompany(snippetAt[1]);

  // Pattern 4: snippet "company/employer: <Name>"
  const snippetCompany = snippet.match(
    /(?:company|organization|employer|firm|work(?:ing)?\s+(?:at|with|for))[\s:]+([A-Z][A-Za-z0-9&\s'.,-]{2,60})/i
  );
  if (snippetCompany) return sanitizeCompany(snippetCompany[1]);

  return "Unknown";
}

// ─── LinkedIn Company Page URL Builder ────────────────────────────────────────
// Constructs a best-effort LinkedIn company URL from the company name.
// Uses slug-style URL — covers most companies registered on LinkedIn.
function buildLinkedInCompanyUrl(company) {
  if (!company || company === "Unknown") return "";

  const slug = company
    .toLowerCase()
    .replace(/\b(pvt\.?\s*ltd\.?|private\s+limited|ltd\.?|limited|inc\.?|corp\.?|llp|llc|group|holdings|industries|enterprises|solutions|services|technologies|tech)\b/gi, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  if (!slug || slug.length < 2) return "";
  return `https://www.linkedin.com/company/${slug}`;
}

// ─── Email Prediction ──────────────────────────────────────────────────────────
function predictEmails(name, company) {
  if (!name || name === "Unknown" || !company || company === "Unknown") return [];
  const cleanName = name
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|CA|CFA|CPA|MBA|IAS|IPS)\b\.?/gi, "")
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
    .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|group|holdings|industries|enterprises|solutions|services|technologies|tech|india|global|international|corp|corporation)\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "");
  if (!clean || clean.length < 2) return null;
  return `${clean}.com`;
}

// ─── Parse Raw Lead from Search Result ────────────────────────────────────────
function parseRawLead(raw) {
  const title   = raw.title       || "";
  const url     = raw.url         || "";  // LinkedIn profile URL — kept as-is
  const snippet = raw.description || "";

  let name    = "Unknown";
  let role    = "Finance Professional";
  let company = "Unknown";

  // Strip LinkedIn suffix from title
  const cleanTitle = title
    .replace(/\s*[\|–-]\s*LinkedIn.*$/i, "")
    .replace(/\s*on LinkedIn.*$/i, "")
    .trim();

  // ── Extract Name + Role + Company ─────────────────────────────────────────
  // Pattern 1: "Name - Role at Company"
  const dashAtMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (dashAtMatch) {
    name    = dashAtMatch[1].trim();
    role    = dashAtMatch[2].trim();
    company = sanitizeCompany(dashAtMatch[3]);
  } else {
    // Pattern 2: "Name - Role | Company" or "Name - Role , Company"
    const pipeMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s*[\|,]\s*(.+)$/i);
    if (pipeMatch) {
      name    = pipeMatch[1].trim();
      role    = pipeMatch[2].trim();
      company = sanitizeCompany(pipeMatch[3]);
    } else {
      // Pattern 3: Just grab name from first segment, role + company from snippet
      name = cleanTitle.split(/[-–|]/)[0].trim() || "Unknown";
      const roleMatch = snippet.match(
        /\b(CFO|Chief Financial Officer|Finance Head|VP Finance|Director Finance|Finance Director|Head of Finance|Finance Controller|Group CFO|Chief Finance Officer)\b/i
      );
      if (roleMatch) role = roleMatch[1];
    }
  }

  // ── If company still unknown, use richer extractor ─────────────────────────
  if (!company || company === "Unknown" || company.length < 2) {
    company = extractCompany(cleanTitle, snippet);
  }

  // Final cleanup of company
  company = company
    .replace(/\s*[\|–-]\s*LinkedIn.*$/i, "")
    .replace(/\s*on LinkedIn.*$/i, "")
    .replace(/\s*[-–|]\s*$/, "")
    .trim();

  if (!company) company = "Unknown";

  // ── Category ───────────────────────────────────────────────────────────────
  const roleLower = (role + " " + title).toLowerCase();
  let category = "Finance Professional";
  if (/\bcfo\b|chief financial/.test(roleLower))               category = "CFO";
  else if (/vp finance|vice president finance/.test(roleLower)) category = "VP Finance";
  else if (/finance head|head of finance/.test(roleLower))      category = "Finance Head";
  else if (/finance director|director finance/.test(roleLower)) category = "Finance Director";
  else if (/finance controller|controller/.test(roleLower))     category = "Finance Controller";
  else if (/group cfo/.test(roleLower))                         category = "Group CFO";

  // ── India filter flag ──────────────────────────────────────────────────────
  const _indiaPass = isIndiaLead(name, company, role, snippet, title);

  // ── LinkedIn company page URL ──────────────────────────────────────────────
  const linkedin_company_url = buildLinkedInCompanyUrl(company);

  // ── Email predictions ──────────────────────────────────────────────────────
  const emails = predictEmails(name, company);

  return {
    name,
    role,
    company,
    category,
    company_size: "Unknown",
    turnover:     "Unknown",
    linkedin_company_url,
    email1: emails[0] || "",
    email2: emails[1] || "",
    email3: emails[2] || "",
    source_url: url,   // LinkedIn profile URL — untouched
    snippet:    snippet.slice(0, 200),
    _indiaPass,
  };
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────────
async function runPipeline() {
  const startTime = Date.now();
  const location  = process.env.TARGET_LOCATION || "India";
  const today     = new Date().toISOString().split("T")[0];

  const stats = {
    date:            today,
    rawCount:        0,
    afterAI:         0,
    afterDedup:      0,
    saved:           0,
    durationSeconds: 0,
    status:          "FAILED",
  };

  console.log("=".repeat(60));
  console.log(`[Pipeline] Starting CFO Lead Generation — ${today}`);
  console.log(`[Pipeline] Target location: ${location}`);
  console.log(`[Pipeline] Mode: India-filtered | Company URL enriched | No Gemini`);
  console.log("=".repeat(60));

  try {
    // ── STEP 1: Scrape ─────────────────────────────────────────────────────
    console.log("\n[Step 1/2] Scraping leads from Google...");
    const rawLeads = await scrapeLeads(location);
    stats.rawCount = rawLeads.length;

    if (rawLeads.length === 0) {
      console.warn("[Pipeline] No raw leads returned. Aborting.");
      stats.status = "EMPTY_SCRAPE";
      await logRun({ ...stats, durationSeconds: elapsed(startTime) });
      return stats;
    }

    console.log(`[Step 1/2] ✅ ${rawLeads.length} raw leads scraped\n`);

    // ── STEP 2: Parse + Filter ─────────────────────────────────────────────
    console.log("[Step 2/2] Parsing leads, applying India filter, building company URLs...");

    const allParsed = rawLeads.map(parseRawLead);
    stats.afterAI = allParsed.length;

    // Strict India-only filter
    const indiaLeads = allParsed.filter(l => l._indiaPass);
    const excluded   = allParsed.length - indiaLeads.length;
    console.log(`[Filter]   ${indiaLeads.length} India-based kept, ${excluded} non-India excluded`);

    // Remove internal flag before saving
    indiaLeads.forEach(l => delete l._indiaPass);

    // Log sample output
    console.log("\n  SAMPLE LEADS:");
    indiaLeads.slice(0, 5).forEach((lead, i) => {
      console.log(`  ${i + 1}. ${lead.name} — ${lead.role} @ ${lead.company}`);
      console.log(`       Profile:      ${lead.source_url}`);
      console.log(`       Company Page: ${lead.linkedin_company_url || "(not found)"}`);
    });
    console.log("");

    const saved = await saveRawLeads(indiaLeads);
    stats.afterDedup = indiaLeads.length;
    stats.saved      = saved;
    stats.status     = "SUCCESS";

    console.log(`[Step 2/2] ✅ ${saved} new India-based leads saved to Google Sheets\n`);

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
  console.log(`  India-only:  ${stats.afterDedup}`);
  console.log(`  Saved:       ${stats.saved}`);
  console.log(`  Duration:    ${stats.durationSeconds}s`);
  console.log("=".repeat(60) + "\n");
}

module.exports = { runPipeline };
