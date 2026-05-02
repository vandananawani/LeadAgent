"use strict";

const axios = require("axios");

const APIFY_BASE = "https://api.apify.com/v2";
const ACTOR_ID = "apify~google-search-scraper";

// ─── Webhook Coordination ──────────────────────────────────────────────────────
// Instead of spinning up its own HTTP server (which would conflict with the
// single public port Render exposes), apify.js registers a one-shot callback
// into a shared registry. The main server in index.js routes POST /apify-webhook
// requests here by calling dispatchWebhook(). This keeps a single PORT=3000
// server handling both health checks AND Apify callbacks.

const webhookRegistry = new Map(); // runId → { resolve, reject, timer }

// Called by index.js server when POST /apify-webhook arrives
function dispatchWebhook(body) {
  let payload;
  try {
    payload = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    console.warn("[Apify/Webhook] Received non-JSON body, ignoring");
    return;
  }

  const runId = payload?.resource?.id || payload?.actorRunId;
  const status = payload?.resource?.status || payload?.status;

  console.log(`[Apify/Webhook] Callback received — runId: ${runId}, status: ${status}`);

  const entry = webhookRegistry.get(runId);
  if (!entry) {
    console.warn(`[Apify/Webhook] No waiter registered for runId ${runId}, ignoring`);
    return;
  }

  webhookRegistry.delete(runId);
  clearTimeout(entry.timer);

  if (status === "SUCCEEDED") {
    entry.resolve(runId);
  } else {
    entry.reject(new Error(`Apify run ended with status: ${status}`));
  }
}

// Returns a Promise that resolves when dispatchWebhook() is called with this
// runId, or rejects after timeoutMs. No server is created here.
function waitForWebhook(expectedRunId, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      webhookRegistry.delete(expectedRunId);
      reject(new Error(`Webhook timed out after ${timeoutMs / 1000}s — Apify never called back`));
    }, timeoutMs);

    webhookRegistry.set(expectedRunId, { resolve, reject, timer });
    console.log(`[Apify/Webhook] Waiting for callback on runId ${expectedRunId}...`);
  });
}

function getWebhookBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.WEBHOOK_URL) return process.env.WEBHOOK_URL;
  return null;
}

// ─── Query Bank ──────────────────────────────────────────────────────────────
// Returns 10 rotating queries based on location and a daily rotation seed
function buildQueries(location = "India") {
  const allQueries = [
    // Broad CFO
    `site:linkedin.com/in "CFO" "${location}"`,
    `site:linkedin.com/in "Chief Financial Officer" "${location}"`,
    `site:linkedin.com/in "Finance Head" "${location}"`,
    `site:linkedin.com/in "VP Finance" "${location}"`,
    `site:linkedin.com/in "Director Finance" "${location}"`,
    `site:linkedin.com/in "Head of Finance" "${location}"`,
    `site:linkedin.com/in "Group CFO" "${location}"`,
    // Industry targeted
    `site:linkedin.com/in "CFO" "Manufacturing" "${location}"`,
    `site:linkedin.com/in "Finance Head" "FMCG" "${location}"`,
    `site:linkedin.com/in "CFO" "Retail" "${location}"`,
    `site:linkedin.com/in "CFO" "Real Estate" "${location}"`,
    `site:linkedin.com/in "CFO" "Logistics" "${location}"`,
    // Company type
    `site:linkedin.com/in "CFO" "Pvt Ltd" "${location}"`,
    `site:linkedin.com/in "CFO" "Holdings" "${location}"`,
    `"CFO" "${location}" "leadership" -jobs -hiring -apply`,
    `site:linkedin.com/in "VP Finance" "Pvt Ltd" "${location}"`,
    // Additional roles
    `site:linkedin.com/in "Finance Controller" "${location}"`,
    `site:linkedin.com/in "Chief Finance" "${location}"`,
    `site:linkedin.com/in "Finance Director" "${location}"`,
    `"Finance Head" "India" company profile -jobs`,
  ];

  // Rotate daily: pick 10 different queries each day
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000
  );
  const offset = (dayOfYear * 3) % allQueries.length;
  const rotated = [
    ...allQueries.slice(offset),
    ...allQueries.slice(0, offset),
  ];
  return rotated.slice(0, 10);
}

// ─── Run Actor ────────────────────────────────────────────────────────────────
async function runApifyActor(queries, webhookUrl = null) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN is not set");

  console.log(`[Apify] Starting actor run with ${queries.length} queries...`);

  const payload = {
    queries: queries.join("\n"),
    maxPagesPerQuery: 3,
    resultsPerPage: 10,
    mobileResults: false,
    languageCode: "en",
    countryCode: "in",
    saveHtml: false,
    saveHtmlToKeyValueStore: false,
  };

  // Build URL — attach webhook to the run request if we have a public URL
  let url = `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${token}`;
  if (webhookUrl) {
    // Apify accepts webhooks as a query param (base64-encoded JSON array)
    const webhooks = Buffer.from(
      JSON.stringify([
        {
          eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.ABORTED"],
          requestUrl: webhookUrl,
          payloadTemplate: JSON.stringify({
            actorRunId: "{{resource.id}}",
            resource: "{{resource}}",
            status: "{{resource.status}}",
          }),
        },
      ])
    ).toString("base64");
    url += `&webhooks=${webhooks}`;
    console.log(`[Apify] Webhook registered: ${webhookUrl}`);
  }

  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  const runId = response.data?.data?.id;
  if (!runId) throw new Error("Apify did not return a run ID");

  console.log(`[Apify] Run started. ID: ${runId}`);
  return runId;
}

// ─── Polling Fallback ─────────────────────────────────────────────────────────
// Used only when no public webhook URL is available (local dev without ngrok).
async function pollForCompletion(runId, timeoutMs = 600000) {
  const token = process.env.APIFY_API_TOKEN;
  const pollInterval = 15000;
  const maxAttempts = Math.floor(timeoutMs / pollInterval);

  console.log(`[Apify/Poll] No webhook URL — falling back to polling run ${runId}`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollInterval);

    const response = await axios.get(
      `${APIFY_BASE}/actor-runs/${runId}?token=${token}`,
      { timeout: 15000 }
    );

    const status = response.data?.data?.status;
    console.log(`[Apify/Poll] Status: ${status} (attempt ${attempt + 1}/${maxAttempts})`);

    if (status === "SUCCEEDED") return;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      throw new Error(`Apify run failed with status: ${status}`);
    }
  }

  throw new Error("Apify polling timed out after 10 minutes");
}

// ─── Fetch Dataset Results ─────────────────────────────────────────────────────
async function fetchDatasetResults(runId) {
  const token = process.env.APIFY_API_TOKEN;

  console.log(`[Apify] Fetching dataset for run ${runId}...`);

  const response = await axios.get(
    `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${token}&format=json&limit=500&clean=true`,
    { timeout: 30000 }
  );

  const items = response.data;
  if (!Array.isArray(items)) throw new Error("Apify dataset returned non-array");

  // Flatten: each item has organicResults array
  const leads = [];
  for (const item of items) {
    const results = item.organicResults || [];
    for (const result of results) {
      if (result.url && result.title) {
        leads.push({
          title: result.title || "",
          url: result.url || "",
          description: result.description || result.snippet || "",
        });
      }
    }
  }

  console.log(`[Apify] Fetched ${leads.length} raw results`);
  return leads;
}

// ─── Main Export: Full Scrape Pipeline ────────────────────────────────────────
async function scrapeLeads(location = "India") {
  const queries = buildQueries(location);
  console.log(`[Apify] Using queries:\n  ${queries.join("\n  ")}`);

  const webhookBase = getWebhookBaseUrl();
  const webhookUrl = webhookBase
    ? `${webhookBase.replace(/\/$/, "")}/apify-webhook`
    : null;

  if (!webhookUrl) {
    console.warn(
      "[Apify] No RENDER_EXTERNAL_URL or WEBHOOK_URL set — using polling fallback.\n" +
      "        Set WEBHOOK_URL=https://your-ngrok-url for local testing with webhooks."
    );
  }

  let runId;
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      runId = await runApifyActor(queries, webhookUrl);
      break;
    } catch (err) {
      attempt++;
      console.error(`[Apify] Start attempt ${attempt} failed: ${err.message}`);
      if (attempt >= maxAttempts) throw err;
      await sleep(10000 * attempt);
    }
  }

  // Wait for completion — webhook if we have a public URL, otherwise poll
  if (webhookUrl) {
    await waitForWebhook(runId);
  } else {
    await pollForCompletion(runId);
  }

  const rawLeads = await fetchDatasetResults(runId);

  // Deduplicate raw results by URL before returning
  const seen = new Set();
  const unique = rawLeads.filter((lead) => {
    if (seen.has(lead.url)) return false;
    seen.add(lead.url);
    return true;
  });

  console.log(`[Apify] ${unique.length} unique raw leads after URL dedup`);
  return unique;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { scrapeLeads, buildQueries, dispatchWebhook };
