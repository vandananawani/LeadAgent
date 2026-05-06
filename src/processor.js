"use strict";

const axios = require("axios");
const { scrapeLeads } = require("./scraper");
const { saveRawLeads, logRun } = require("./sheets");

// ─── Heuristic Turnover Estimator (no API needed) ─────────────────────────────
function estimateTurnover(company, snippet) {
  const text = (company + " " + snippet).toLowerCase();

  // Large enterprise signals
  if (/\b(group|holdings|industries|enterprises|conglomerate)\b/.test(text) &&
      /\b(ltd|limited|pvt)\b/.test(text)) return "500–2000 Cr";
  if (/\b(group|holdings|industries)\b/.test(text)) return "200–2000 Cr";

  // Listed / large company signals
  if (/\b(bse|nse|listed|ipo|public limited)\b/.test(text)) return "500+ Cr";
  if (/\b(bank|insurance|nbfc|financial services)\b/.test(text)) return "1000+ Cr";
  if (/\b(hospital|healthcare|pharma|pharmaceutical)\b/.test(text)) return "100–500 Cr";
  if (/\b(infrastructure|construction|epc|power|energy|oil|steel|cement)\b/.test(text)) return "200–1000 Cr";
  if (/\b(retail|fmcg|consumer|goods|food|beverage)\b/.test(text)) return "100–500 Cr";
  if (/\b(manufacturing|automobile|auto|textile|garment)\b/.test(text)) return "50–500 Cr";
  if (/\b(it|software|technology|tech|digital|saas|startup)\b/.test(text)) return "10–200 Cr";
  if (/\b(logistics|supply chain|warehouse|transport)\b/.test(text)) return "50–200 Cr";
  if (/\b(real estate|realty|property|developer|builder)\b/.test(text)) return "100–500 Cr";

  // Company type signals
  if (/\bpvt\.?\s*ltd\b/.test(text)) return "10–100 Cr";
  if (/\bltd\b|\blimited\b/.test(text)) return "100–500 Cr";
  if (/\bllp\b/.test(text)) return "5–50 Cr";

  return "Unknown";
}

function estimateCompanySize(company, snippet) {
  const text = (company + " " + snippet).toLowerCase();

  if (/\b(group|holdings|conglomerate)\b/.test(text) &&
      /\b(ltd|limited)\b/.test(text)) return "5000+ employees";
  if (/\b(group|holdings|industries|enterprises)\b/.test(text)) return "1000–10000 employees";
  if (/\b(bank|insurance|listed|bse|nse)\b/.test(text)) return "1000+ employees";
  if (/\b(manufacturing|pharma|hospital|infrastructure)\b/.test(text)) return "500–5000 employees";
  if (/\b(retail|fmcg|logistics|construction)\b/.test(text)) return "200–2000 employees";
  if (/\b(it|software|tech|saas|startup|digital)\b/.test(text)) return "50–500 employees";
  if (/\bpvt\.?\s*ltd\b/.test(text)) return "50–500 employees";
  if (/\bltd\b|\blimited\b/.test(text)) return "200–2000 employees";

  return "Unknown";
}

// ─── Company LinkedIn URL ──────────────────────────────────────────────────────
function buildCompanyLinkedInUrl(company) {
  if (!company || company === "Unknown") return "";
  const slug = company
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|group|holdings|industries|enterprises|solutions|services|technologies|tech|india|global|international|and|&)\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || slug.length < 2) return "";
  return `https://www.linkedin.com/company/${slug}`;
}

// ─── Email Prediction ──────────────────────────────────────────────────────────
function predictEmails(name, company) {
  if (!name || name === "Unknown" || !company || company === "Unknown") return [];
  const cleanName = name
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|CA|CFA|CPA|MBA|ACCA|ACA)\b\.?/gi, "")
    .trim();
  const parts = cleanName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const first = parts[0].toLowerCase().replace(/[^a-z]/g, "");
  const last = parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, "");
  if (!first || !last) return [];
  const domain = guessDomain(company);
  if (!domain) return [];
  return [
    `${first}.${last}@${domain}`,
    `${first[0]}${last}@${domain}`,
    `${first}@${domain}`,
  ];
}

function guessDomain(company) {
  if (!company || company === "Unknown") return null;
  const clean = company
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|group|holdings|industries|enterprises|solutions|services|technologies|tech|india|global|international|and|&)\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "");
  if (!clean || clean.length < 2) return null;
  return `${clean}.com`;
}

// ─── India Filter ──────────────────────────────────────────────────────────────
function isIndiaBased(raw) {
  const text = (raw.title + " " + raw.description + " " + raw.url).toLowerCase();

  // Must be LinkedIn URL
  if (!raw.url.includes("linkedin.com")) return false;

  // Exclude obvious non-India countries
  const excludeCountries = [
    "usa", "united states", "uk", "united kingdom", "canada", "australia",
    "singapore", "dubai", "uae", "germany", "france", "netherlands",
    "new zealand", "south africa", "kenya", "nigeria", "pakistan",
    "bangladesh", "sri lanka", "malaysia", "indonesia", "philippines",
  ];
  for (const country of excludeCountries) {
    if (text.includes(country)) return false;
  }

  // Positive India signals — at least one must be present
  const indiaSignals = [
    "india", "indian", "mumbai", "delhi", "bangalore", "bengaluru",
    "chennai", "hyderabad", "pune", "kolkata", "ahmedabad", "surat",
    "jaipur", "lucknow", "noida", "gurgaon", "gurugram", "chandigarh",
    "pvt ltd", "pvt. ltd", "private limited", "crore", "inr", "rupee",
    "in.linkedin.com",
  ];
  return indiaSignals.some((signal) => text.includes(signal));
}

// ─── Parse Raw Lead ────────────────────────────────────────────────────────────
function parseRawLead(raw) {
  const title = raw.title || "";
  const url = raw.url || "";
  const snippet = raw.description || "";

  let name = "Unknown";
  let role = "Finance Professional";
  let company = "Unknown";

  // Clean title — strip LinkedIn suffix and noise
  const cleanTitle = title
    .replace(/\s*[-–|]\s*LinkedIn.*$/i, "")
    .replace(/\s*on LinkedIn.*$/i, "")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s*·\s*LinkedIn.*$/i, "")
    .trim();

  // ── Strategy 1: "Name - Role at Company" ──
  const atMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (atMatch) {
    name = atMatch[1].trim();
    role = atMatch[2].trim();
    company = atMatch[3].trim();
  }

  // ── Strategy 2: "Name - Role | Company" or "Name - Role, Company" ──
  if (company === "Unknown") {
    const pipeMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*([^|,·]{3,60})\s*[|,·]\s*(.{3,})$/);
    if (pipeMatch) {
      name = pipeMatch[1].trim();
      role = pipeMatch[2].trim();
      company = pipeMatch[3].trim();
    }
  }

  // ── Strategy 3: "Name - Role" only (no company in title) ──
  if (name === "Unknown") {
    const simpleMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+)$/);
    if (simpleMatch) {
      name = simpleMatch[1].trim();
      role = simpleMatch[2].trim();
    }
  }

  // ── Strategy 4: Extract name from LinkedIn URL slug ──
  if (name === "Unknown" || isUsernameSlug(name)) {
    const urlMatch = url.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (urlMatch) {
      const slug = urlMatch[1]
        .replace(/-\d{4,}$/, "")       // strip trailing IDs: -123456
        .replace(/-[a-z0-9]{8,}$/, ""); // strip hash suffixes
      const parts = slug.split("-").filter(p => p.length > 1 && !/^\d+$/.test(p));
      if (parts.length >= 2) {
        name = parts.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      }
    }
  }

  // ── Strategy 5: Extract company from snippet ──
  if (company === "Unknown" || company === "") {
    // Pattern 1: "at Company Name" in snippet
    const atSnippet = snippet.match(/\bat\s+([A-Z][A-Za-z0-9\s&.,'-]{2,50}?)(?:\.|,|\s{2}|·|\n|$)/);
    if (atSnippet) company = atSnippet[1].trim();
  }

  if (company === "Unknown" || company === "") {
    // Pattern 2: LinkedIn bullet format "Role · Company · Location"
    // Must be between two bullets AND not a location/date word
    const bulletMatches = [...snippet.matchAll(/·\s*([A-Z][A-Za-z0-9\s&.,'-]{2,60}?)\s*·/g)];
    for (const m of bulletMatches) {
      const candidate = m[1].trim();
      // Skip if it looks like a location (India, Mumbai, Delhi etc.) or date
      if (/^(India|Mumbai|Delhi|Bangalore|Bengaluru|Chennai|Hyderabad|Pune|Kolkata|Noida|Gurgaon|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})/i.test(candidate)) continue;
      // Skip if too short
      if (candidate.length < 3) continue;
      company = candidate;
      break;
    }
  }

  if (company === "Unknown" || company === "") {
    // Pattern 3: "Role - Company" in snippet
    const dashSnippet = snippet.match(/(?:CFO|Finance|Director|Controller|VP|Head|Officer)[^-–]{0,30}[-–]\s*([A-Z][A-Za-z0-9\s&.,'-]{2,50})/);
    if (dashSnippet) company = dashSnippet[1].trim();
  }

  if (company === "Unknown" || company === "") {
    // Pattern 4: Company with known legal suffixes anywhere in snippet
    const suffixMatch = snippet.match(/([A-Z][A-Za-z0-9\s&.,'-]{2,50}(?:Ltd|Limited|Pvt|Private|Group|Industries|Holdings|Inc|Corp|LLP|Bank|Retail|Pharma)\.?)/);
    if (suffixMatch) company = suffixMatch[1].trim();
  }

  // ── Clean up name — remove professional titles/suffixes ──
  name = name
    .replace(/\b(CA|CFA|CPA|MBA|ACCA|ACA|FCCA|FCA|CMA|CFP|PhD|Dr|Mr|Mrs|Ms|Prof|IAS|IRS)\b\.?/gi, "")
    .replace(/[|·•,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // If still looks like a username slug, try URL again
  if (isUsernameSlug(name)) {
    const urlMatch = url.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (urlMatch) {
      const slug = urlMatch[1].replace(/-\d{4,}$/, "");
      const parts = slug.split("-").filter(p => p.length > 1 && !/^\d+$/.test(p));
      if (parts.length >= 2) {
        name = parts.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      } else {
        name = "Unknown";
      }
    }
  }

  // ── Clean up role ──
  role = role
    .replace(/\s*[-–|·]\s*.*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  // ── Clean up company ──
  company = company
    .replace(/\s*[-–|·•]\s*.*$/, "")       // remove anything after separator
    .replace(/\.\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4}).*$/i, "") // strip dates
    .replace(/\.\s*(India|Mumbai|Delhi|Bangalore|Bengaluru|Chennai|Pune|Hyderabad|Noida|Gurgaon).*$/i, "") // strip locations
    .replace(/\s+/g, " ")
    .trim();

  // Reject if company is just a location or too short
  const locationWords = ["india", "mumbai", "delhi", "bangalore", "bengaluru", "chennai", "pune", "hyderabad", "noida", "gurgaon", "kolkata", "south asia", "asia"];
  if (locationWords.includes(company.toLowerCase()) || company.length < 3) {
    company = "Unknown";
  }

  // Reject if company looks like a role title accidentally captured
  if (/^(cfo|vp|director|head|chief|finance|manager|officer|president|vice|group)/i.test(company) &&
      !/(ltd|limited|pvt|group\s+of|industries|holdings)/i.test(company)) {
    company = "Unknown";
  }

  // ── Determine category from all available text ──
  const catText = (role + " " + title + " " + snippet).toLowerCase();
  let category = "Finance Professional";
  if (/\bgroup\s+cfo\b/.test(catText)) category = "CFO";
  else if (/\bcfo\b|chief\s+financial\s+officer/.test(catText)) category = "CFO";
  else if (/\bvp[\s-]+finance\b|vice\s+president[\s\S]{0,15}finance/.test(catText)) category = "VP Finance";
  else if (/\bfinance\s+head\b|head\s+of\s+finance/.test(catText)) category = "Finance Head";
  else if (/\bfinance\s+director\b|director[\s\S]{0,10}finance/.test(catText)) category = "Finance Director";
  else if (/\bfinance\s+controller\b|\bcontroller\b/.test(catText)) category = "Finance Controller";

  const emails = predictEmails(name, company);
  const turnover = estimateTurnover(company, snippet);
  const companySize = estimateCompanySize(company, snippet);
  const companyLinkedIn = buildCompanyLinkedInUrl(company);

  return {
    name: name || "Unknown",
    role: role || "Finance Professional",
    company: company || "Unknown",
    category,
    company_size: companySize,
    turnover,
    company_linkedin: companyLinkedIn,
    email1: emails[0] || "",
    email2: emails[1] || "",
    email3: emails[2] || "",
    source_url: url,
    snippet: snippet.slice(0, 250),
  };
}

// Returns true if string looks like a username slug not a real name
function isUsernameSlug(str) {
  if (!str || str === "Unknown") return true;
  // Has digits mixed with letters and no spaces = likely slug
  return /\d/.test(str) && !/\s/.test(str);
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
    // ── STEP 1: Scrape ─────────────────────────────────────────
    console.log("\n[Step 1/2] Scraping leads...");
    const rawLeads = await scrapeLeads(location);
    stats.rawCount = rawLeads.length;

    if (rawLeads.length === 0) {
      console.warn("[Pipeline] No raw leads returned. Aborting.");
      stats.status = "EMPTY_SCRAPE";
      await logRun({ ...stats, durationSeconds: elapsed(startTime) });
      return stats;
    }

    // Filter India-based only
    const indiaLeads = rawLeads.filter(isIndiaBased);
    console.log(`[Step 1/2] ✅ ${rawLeads.length} total → ${indiaLeads.length} India-based leads\n`);

    // ── STEP 2: Parse + Save ────────────────────────────────────
    console.log("[Step 2/2] Parsing and saving to Google Sheets...");
    const parsedLeads = indiaLeads.map(parseRawLead);
    stats.afterAI = parsedLeads.length;

    // Print sample
    console.log("\n  SAMPLE LEADS:");
    parsedLeads.slice(0, 5).forEach((lead, i) => {
      console.log(`  ${i + 1}. ${lead.name} — ${lead.role} @ ${lead.company} | Turnover: ${lead.turnover}`);
    });
    console.log("");

    const saved = await saveRawLeads(parsedLeads);
    stats.afterDedup = parsedLeads.length;
    stats.saved = saved;
    stats.status = "SUCCESS";

    console.log(`[Step 2/2] ✅ ${saved} new leads saved\n`);

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
  console.log(`  India leads: ${stats.afterAI}`);
  console.log(`  Saved:       ${stats.saved}`);
  console.log(`  Duration:    ${stats.durationSeconds}s`);
  console.log("=".repeat(60) + "\n");
}

module.exports = { runPipeline };
