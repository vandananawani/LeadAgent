"use strict";

require("dotenv").config();

const http = require("http");
const { runPipeline } = require("./src/processor");
const { startScheduler } = require("./src/scheduler");
const { hasRunToday } = require("./src/sheets");

function validateEnv() {
  const required = [
    "GOOGLE_SHEETS_ID",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach((k) => console.error(`   - ${k}`));
    process.exit(1);
  }

  // Warn if no search provider key set
  const searchKeys = ["SERPER_API_KEY", "VALUESERP_API_KEY", "SERPAPI_KEY"];
  const hasSearch = searchKeys.some((k) => process.env[k]);
  if (!hasSearch) {
    console.error("❌ No search API key set. Set at least one of:");
    searchKeys.forEach((k) => console.error(`   - ${k}`));
    console.error("   Get free key at serper.dev (2500 free searches)");
    process.exit(1);
  }

  console.log("✅ Environment variables validated\n");
}

// Simple health check server — keeps Render alive and answers UptimeRobot pings
function startHealthServer() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "cfo-lead-agent", time: new Date().toISOString() }));
  });
  server.listen(port, () => {
    console.log(`[Server] Health check server on port ${port}`);
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  return server;
}

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

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║      CFO Lead Generation Agent v2.0     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  validateEnv();

  const runOnce = process.argv.includes("--run-once");

  if (runOnce) {
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

  console.log("[Mode] Scheduler mode — starting daemon\n");
  startHealthServer();
  await new Promise((r) => setTimeout(r, 500));
  runMissedCheck().catch((err) =>
    console.error(`[Startup] Error: ${err.message}`)
  );
  startScheduler();
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
