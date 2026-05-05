"use strict";

const axios = require("axios");

// ─── Query Bank ────────────────────────────────────────────────────────────────
function buildQueries(location = "India") {
  const allQueries = [
    `site:linkedin.com/in "CFO" "${location}"`,
    `site:linkedin.com/in "Chief Financial Officer" "${location}"`,
    `site:linkedin.com/in "Finance Head" "${location}"`,
    `site:linkedin.com/in "VP Finance" "${location}"`,
    `site:linkedin.com/in "Director Finance" "${location}"`,
    `site:linkedin.com/in "Head of Finance" "${location}"`,
    `site:linkedin.com/in "Group CFO" "${location}"`,
    `site:linkedin.com/in "CFO" "Manufacturing" "${location}"`,
    `site:linkedin.com/in "Finance Head" "FMCG" "${location}"`,
    `site:linkedin.com/in "CFO" "Retail" "${location}"`,
    `site:linkedin.com/in "CFO" "Real Estate" "${location}"`,
    `site:linkedin.com/in "CFO" "Logistics" "${location}"`,
    `site:linkedin.com/in "CFO" "Pvt Ltd" "${location}"`,
    `site:linkedin.com/in "CFO" "Holdings" "${location}"`,
    `site:linkedin.com/in "VP Finance" "Pvt Ltd" "${location}"`,
    `site:linkedin.com/in "Finance Controller" "${location}"`,
    `site:linkedin.com/in "Finance Director" "${location}"`,
    `site:linkedin.com/in "Chief Finance" "${location}"`,
    `"CFO" "${location}" "leadership" -jobs -hiring`,
    `site:linkedin.com/in "Finance Head" "India"`,
  ];

  // Rotate daily — different 10 queries each day
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000
  );
  const offset = (dayOfYear * 3) % allQueries.length;
  const rotated = [...allQueries.slice(offset), ...allQueries.slice(0, offset)];
  return rotated.slice(0, 10);
}

// ─── Serper.dev Search ─────────────────────────────────────────────────────────
// Free: 2500 searches on signup — no credit card
// Sign up at: serper.dev → get API key → add as SERPER_API_KEY env var
async function searchWithSerper(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY not set");

  const response = await axios.post(
    "https://google.serper.dev/search",
    { q: query, num: 10, gl: "in", hl: "en" },
    {
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  const results = response.data?.organic || [];
  return results.map((r) => ({
    title: r.title || "",
    url: r.link || "",
    description: r.snippet || "",
  }));
}

// ─── ValueSerp Fallback ────────────────────────────────────────────────────────
// Free: 100 searches/month — sign up at valueserp.com
async function searchWithValueSerp(query) {
  const key = process.env.VALUESERP_API_KEY;
  if (!key) throw new Error("VALUESERP_API_KEY not set");

  const response = await axios.get("https://api.valueserp.com/search", {
    params: { api_key: key, q: query, num: 10, gl: "in", hl: "en" },
    timeout: 15000,
  });

  const results = response.data?.organic_results || [];
  return results.map((r) => ({
    title: r.title || "",
    url: r.link || "",
    description: r.snippet || "",
  }));
}

// ─── SerpApi Fallback ──────────────────────────────────────────────────────────
// Free: 100 searches/month — sign up at serpapi.com
async function searchWithSerpApi(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY not set");

  const response = await axios.get("https://serpapi.com/search", {
    params: { api_key: key, q: query, num: 10, gl: "in", hl: "en", engine: "google" },
    timeout: 15000,
  });

  const results = response.data?.organic_results || [];
  return results.map((r) => ({
    title: r.title || "",
    url: r.link || "",
    description: r.snippet || "",
  }));
}

// ─── Search with Fallback Chain ────────────────────────────────────────────────
// Tries Serper first (most free credits), falls back to ValueSerp, then SerpApi
async function searchQuery(query) {
  const providers = [
    { name: "Serper", fn: searchWithSerper },
    { name: "ValueSerp", fn: searchWithValueSerp },
    { name: "SerpApi", fn: searchWithSerpApi },
  ];

  for (const provider of providers) {
    const keyMap = {
      Serper: "SERPER_API_KEY",
      ValueSerp: "VALUESERP_API_KEY",
      SerpApi: "SERPAPI_KEY",
    };
    if (!process.env[keyMap[provider.name]]) continue; // Skip if no key

    try {
      const results = await provider.fn(query);
      console.log(`[Scraper] "${query.slice(0, 50)}..." → ${results.length} results via ${provider.name}`);
      return results;
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 || status === 429 || status === 402) {
        console.warn(`[Scraper] ${provider.name} quota/auth error (${status}), trying next...`);
        continue;
      }
      console.error(`[Scraper] ${provider.name} error: ${err.message}, trying next...`);
    }
  }

  console.warn(`[Scraper] All providers failed for query: ${query}`);
  return [];
}

// ─── Main Export ───────────────────────────────────────────────────────────────
async function scrapeLeads(location = "India") {
  const queries = buildQueries(location);
  console.log(`[Scraper] Running ${queries.length} queries...`);
  console.log(`[Scraper] Queries:\n  ${queries.join("\n  ")}`);

  const allResults = [];
  const seen = new Set();

  for (let i = 0; i < queries.length; i++) {
    const results = await searchQuery(queries[i]);

    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      // Only keep LinkedIn URLs
      if (!r.url.includes("linkedin.com")) continue;
      seen.add(r.url);
      allResults.push(r);
    }

    // Small delay between queries to be respectful
    if (i < queries.length - 1) await sleep(1000);
  }

  console.log(`[Scraper] Total: ${allResults.length} unique LinkedIn results`);
  return allResults;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { scrapeLeads, buildQueries };
