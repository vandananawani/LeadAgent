"use strict";

require("dotenv").config();

const http = require("http");
const { runPipeline } = require("./src/processor");
const { startScheduler } = require("./src/scheduler");
const { hasRunToday } = require("./src/sheets");
const { dispatchWebhook } = require("./src/apify");

// ─── Validate Required Env Vars ───────────────────────────────────────────────
function validateEnv() {
  const required = [
    "APIFY_API_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_SHEETS_ID",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach((k) => console.error(`   - ${k}`));
    console.error("\nCopy .env.example to .env and fill in your values.");
    process.exit(1);
  }

  console.log("✅ Environment variables validated\n");
}

// ─── Unified HTTP Server ───────────────────────────────────────────────────────
// Single server on PORT (the only port Render exposes publicly).
// Handles three routes:
//   GET  /         → health check (200 OK)
//   GET  /health   → health check (200 OK)
//   POST /apify-webhook → Apify run completion callback
//
// The webhook route collects the full body then calls dispatchWebhook() from
// apify.js, which resolves the Promise that scrapeLeads() is awaiting.
// No second server, no port conflicts.

function startServer() {
  const port = parseInt(process.env.PORT || "3000", 10);

  const server = http.createServer((req, res) => {
    // ── Health check ──
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "cfo-lead-agent",
          time: new Date().toISOString(),
        })
      );
      return;
    }

    // ── Apify webhook ──
    if (req.method === "POST" && req.url === "/apify-webhook") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        // Respond immediately so Apify doesn't retry
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        // Dispatch to the waiting scrapeLeads() call
        dispatchWebhook(body);
      });
      return;
    }

    // ── Everything else ──
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    const externalUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
    console.log(`[Server] Listening on port ${port}`);
    console.log(`[Server] Webhook endpoint: ${externalUrl}/apify-webhook`);
    console.log(`[Server] Health endpoint:  ${externalUrl}/health\n`);
  });

  server.on("error", (err) => {
    console.error(`[Server] Failed to start: ${err.message}`);
    process.exit(1);
  });

  return server;
}

// ─── Startup Run Check ────────────────────────────────────────────────────────
// Render free tier can restart the process at any time. If it restarts AFTER
// the cron trigger time (e.g. restarts at 6:05 AM when cron fires at 6:00 AM),
// node-cron will not fire again until tomorrow — silently skipping today's run.
//
// Fix: on every startup, check the RunLog sheet. If no SUCCESS row exists for
// today, run the pipeline immediately, then let the cron handle future days.

async function runMissedCheck() {
  console.log("[Startup] Checking if today's pipeline run was missed...");
  try {
    const alreadyRan = await hasRunToday();
    if (!alreadyRan) {
      console.log("[Startup] No successful run found for today — running now\n");
      await runPipeline();
    } else {
      console.log("[Startup] Today's run already completed — waiting for tomorrow's cron\n");
    }
  } catch (err) {
    console.error(`[Startup] Missed-run check failed: ${err.message}`);
    console.error("[Startup] Proceeding anyway — cron will handle tomorrow\n");
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function registerShutdownHandlers(server) {
  const shutdown = (signal) => {
    console.log(`\n[Shutdown] ${signal} received — closing server`);
    server.close(() => {
      console.log("[Shutdown] Server closed. Exiting.");
      process.exit(0);
    });
    // Force exit after 10s if server hangs
    setTimeout(() => process.exit(1), 10000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ─── Entry Point ──────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║      CFO Lead Generation Agent v1.0     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  validateEnv();

  const runOnce = process.argv.includes("--run-once");

  if (runOnce) {
    // --run-once: execute pipeline immediately and exit (for testing)
    console.log("[Mode] Run-once — executing pipeline now...\n");
    try {
      const stats = await runPipeline();
      process.exit(stats.status === "SUCCESS" ? 0 : 1);
    } catch (err) {
      console.error(`Fatal: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Production mode:
  // 1. Start the unified HTTP server (health + webhook on single PORT)
  // 2. Check if today's run was missed (handles Render restarts)
  // 3. Start cron for all future daily runs
  console.log("[Mode] Scheduler mode — starting daemon\n");

  const server = startServer();
  registerShutdownHandlers(server);

  // Small delay to let server bind before any async work
  await new Promise((r) => setTimeout(r, 500));

  // Check for missed run (non-blocking — cron starts regardless)
  runMissedCheck().catch((err) =>
    console.error(`[Startup] Unhandled error in missed-run check: ${err.message}`)
  );

  // Register daily cron
  startScheduler();
}

main().catch((err) => {
  console.error("Unhandled error in main:", err);
  process.exit(1);
});

