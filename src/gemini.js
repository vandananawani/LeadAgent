"use strict";

const axios = require("axios");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ─── Build Prompt ──────────────────────────────────────────────────────────────
function buildPrompt(leads) {
  const leadsText = leads
    .map(
      (l, i) =>
        `[${i + 1}]\nTITLE: ${l.title}\nURL: ${l.url}\nSNIPPET: ${l.description}`
    )
    .join("\n\n");

  return `You are a B2B lead qualification engine for a GST/finance compliance SaaS company targeting Indian businesses. Analyze these Google search results and extract CFO / Finance decision-maker leads.

RAW SEARCH RESULTS:
${leadsText}

CLASSIFICATION RULES:
- "CFO": confirmed Chief Financial Officer title
- "Finance Decision Maker": VP Finance, Finance Head, Director Finance, Head of Finance, Finance Controller, Group Finance, Chief Finance
- "Not Relevant": student, job seeker, recruiter, course, article, blog post, job listing, consultant without company, irrelevant person

SCORING RULES (1-10):
Base score by seniority:
- CFO = 9
- Group CFO / Chief Finance Officer = 10
- VP Finance / Finance Director = 8
- Finance Head / Head of Finance = 7
- Director Finance / Finance Controller = 6
- Other finance roles = 5

Adjustments:
+1 if company has "Group", "Holdings", "Industries" (larger company)
+1 if snippet mentions GST, compliance, taxation, ERP, SAP, Tally, financial reporting
-1 if company is very small startup signal
-2 if name is unclear or "Unknown"
-3 if "Not Relevant"

COMPANY SIZE HEURISTICS:
- "Pvt Ltd" without Group = "SME (50-500 employees)"
- "Ltd" (public/listed signals) = "Mid-Market (500-5000 employees)"  
- "Group", "Industries", "Holdings", "Enterprises" = "Enterprise (5000+ employees)"
- Startup / tech / seed signals = "Startup (10-200 employees)"
- No clear signals = "Unknown"

EMAIL FORMAT RULES:
Generate 3 probable professional email predictions using the person's name and company domain.
Guess domain from company name: "Infra Solutions Pvt Ltd" → "infrasolutions.com"
Formats:
1. firstname.lastname@domain.com
2. flastname@domain.com (first initial + lastname)
3. firstname@domain.com

IMPORTANT:
- DROP all "Not Relevant" leads from output entirely
- DROP leads with lead_score < 4
- If name cannot be extracted, use "Unknown" but still include if company is clear
- Strip "LinkedIn" and "| LinkedIn" from extracted names
- Company name should be clean (no "LinkedIn", no pipe characters)

RESPOND WITH ONLY THIS JSON OBJECT — no explanation, no markdown fences, no preamble:
{
  "leads": [
    {
      "name": "Full Name",
      "role": "Exact role title",
      "company": "Company Name",
      "category": "CFO or Finance Decision Maker",
      "company_size": "size estimate string",
      "lead_score": 8,
      "email_predictions": ["email1@domain.com", "email2@domain.com", "email3@domain.com"],
      "source_url": "https://linkedin.com/..."
    }
  ]
}`;
}

// ─── Resilient JSON Extractor ─────────────────────────────────────────────────
// Gemini sometimes wraps output in markdown, adds commentary before/after the
// JSON, or returns a truncated object when the batch is large. This function
// tries multiple strategies before giving up.
function extractLeadsFromText(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  // Strategy 1: responseMimeType worked, direct parse
  try {
    const parsed = JSON.parse(rawText.trim());
    if (Array.isArray(parsed?.leads)) return parsed.leads;
  } catch {}

  // Strategy 2: strip ```json ... ``` fences
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed?.leads)) return parsed.leads;
    } catch {}
  }

  // Strategy 3: find the first { ... } block in the response
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const jsonSlice = rawText.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(jsonSlice);
      if (Array.isArray(parsed?.leads)) return parsed.leads;
    } catch {}
  }

  // Strategy 4: Gemini returned a JSON array directly (no wrapper object)
  const firstBracket = rawText.indexOf("[");
  const lastBracket = rawText.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const arr = JSON.parse(rawText.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.role) return arr;
    } catch {}
  }

  // Strategy 5: response was truncated — extract complete lead objects using regex
  // This rescues partial batches where Gemini cuts off mid-response
  const leadPattern = /\{[^{}]*"name"\s*:[^{}]*"role"\s*:[^{}]*"company"\s*:[^{}]*\}/g;
  const partialMatches = rawText.match(leadPattern) || [];
  if (partialMatches.length > 0) {
    const rescued = partialMatches.reduce((acc, m) => {
      try {
        acc.push(JSON.parse(m));
      } catch {}
      return acc;
    }, []);
    if (rescued.length > 0) {
      console.warn(`[Gemini] Used regex rescue — recovered ${rescued.length} leads from partial response`);
      return rescued;
    }
  }

  return null;
}

// ─── Single API Call ───────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      // Note: responseMimeType removed — it conflicts with thinkingConfig on
      // Gemini 2.5 Flash causing 400 errors. The extractLeadsFromText function
      // handles raw text responses with 5 fallback strategies.
      thinkingConfig: {
        thinkingBudget: 0, // Disable thinking — faster, cheaper, no conflicts
      },
    },
  };

  const response = await axios.post(`${GEMINI_URL}?key=${key}`, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000,
  });

  // Check for API-level errors returned as 200 with error body
  if (response.data?.error) {
    throw new Error(`Gemini API error: ${response.data.error.message}`);
  }

  const candidate = response.data?.candidates?.[0];

  // Blocked by safety filters
  if (!candidate) {
    const blockReason = response.data?.promptFeedback?.blockReason;
    throw new Error(`Gemini returned no candidates. Block reason: ${blockReason || "unknown"}`);
  }

  // Stopped for unusual reasons
  const finishReason = candidate.finishReason;
  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    throw new Error(`Gemini stopped unexpectedly: ${finishReason}`);
  }

  const rawText = candidate?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Gemini returned empty text content");

  const leads = extractLeadsFromText(rawText);

  if (!leads) {
    // Log a snippet for debugging but don't crash the whole run
    console.error(`[Gemini] All extraction strategies failed. Raw response snippet:\n${rawText.slice(0, 500)}`);
    throw new Error("Could not extract valid leads array from Gemini response");
  }

  return leads;
}

// ─── Batch Call with Retry ─────────────────────────────────────────────────────
async function processLeadBatch(leads, batchIndex) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const prompt = buildPrompt(leads);
      const results = await callGemini(prompt);
      console.log(
        `[Gemini] Batch ${batchIndex}: ${results.length} leads extracted from ${leads.length} raw`
      );
      return results;
    } catch (err) {
      const isRateLimit =
        err.response?.status === 429 ||
        err.message?.includes("quota") ||
        err.message?.includes("rate");

      console.error(
        `[Gemini] Batch ${batchIndex} attempt ${attempt} failed: ${err.message}`
      );

      if (attempt >= maxAttempts) {
        console.error(`[Gemini] Batch ${batchIndex} permanently failed, skipping`);
        return [];
      }

      // Rate limit: wait longer
      const waitMs = isRateLimit ? 60000 : 4000 * attempt;
      console.log(`[Gemini] Waiting ${waitMs / 1000}s before retry...`);
      await sleep(waitMs);
    }
  }

  return [];
}

// ─── Main Export: Process All Leads ───────────────────────────────────────────
async function processAllLeads(rawLeads, batchSize = 20) {
  const minScore = parseInt(process.env.MIN_LEAD_SCORE || "6", 10);
  const results = [];
  const totalBatches = Math.ceil(rawLeads.length / batchSize);

  console.log(
    `[Gemini] Processing ${rawLeads.length} leads in ${totalBatches} batches of ${batchSize}`
  );

  for (let i = 0; i < rawLeads.length; i += batchSize) {
    const batch = rawLeads.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    process.stdout.write(
      `[Gemini] Processing batch ${batchNum}/${totalBatches}... `
    );

    const processed = await processLeadBatch(batch, batchNum);

    // Validate and filter each lead
    for (const lead of processed) {
      if (!isValidLead(lead)) continue;
      if (lead.lead_score < minScore) continue;
      results.push(normalizeLead(lead));
    }

    console.log(`Running total: ${results.length} qualified leads`);

    // Respect Gemini rate limits: 15 RPM for free tier
    // Wait 5s between batches to stay under limit
    if (i + batchSize < rawLeads.length) {
      await sleep(5000);
    }
  }

  console.log(
    `[Gemini] Done. ${results.length} leads passed score >= ${minScore} filter`
  );
  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidLead(lead) {
  if (!lead || typeof lead !== "object") return false;
  if (!lead.company || lead.company === "") return false;
  if (!lead.role || lead.role === "") return false;
  if (typeof lead.lead_score !== "number") return false;
  if (lead.lead_score < 1 || lead.lead_score > 10) return false;
  if (!["CFO", "Finance Decision Maker"].includes(lead.category)) return false;
  return true;
}

function normalizeLead(lead) {
  return {
    name: String(lead.name || "Unknown").trim(),
    role: String(lead.role || "").trim(),
    company: String(lead.company || "").trim(),
    category: lead.category,
    company_size: String(lead.company_size || "Unknown").trim(),
    lead_score: Number(lead.lead_score),
    email_predictions: Array.isArray(lead.email_predictions)
      ? lead.email_predictions.filter((e) => typeof e === "string" && e.includes("@"))
      : [],
    source_url: String(lead.source_url || "").trim(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { processAllLeads, processLeadBatch };
