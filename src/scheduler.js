"use strict";

const cron = require("node-cron");
const { runPipeline } = require("./processor");

// ─── Cron Scheduler ───────────────────────────────────────────────────────────
function startScheduler() {
  const schedule = process.env.CRON_SCHEDULE || "0 6 * * *";

  // Validate cron expression
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: "${schedule}". Example: "0 6 * * *" = 6:00 AM daily`);
  }

  console.log(`[Scheduler] Agent scheduled with cron: "${schedule}"`);
  console.log(`[Scheduler] Next runs:`);

  // Show next 3 run times approximately
  const now = new Date();
  console.log(`  Current time: ${now.toISOString()}`);
  console.log(`  Timezone: UTC (Render/cloud servers run UTC)`);
  console.log(`  Note: "0 6 * * *" = 6:00 AM UTC = 11:30 AM IST`);
  console.log(`  Note: "30 0 * * *" = 12:30 AM UTC = 6:00 AM IST`);

  // Register cron job
  const job = cron.schedule(
    schedule,
    async () => {
      console.log(`\n[Scheduler] ⏰ Cron triggered at ${new Date().toISOString()}`);
      try {
        await runPipeline();
      } catch (err) {
        console.error(`[Scheduler] Pipeline crashed: ${err.message}`);
        console.error(err.stack);
        // Don't exit — keep scheduler alive for tomorrow's run
      }
    },
    {
      scheduled: true,
      timezone: "UTC", // Render runs UTC; adjust CRON_SCHEDULE accordingly
    }
  );

  // Handle graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[Scheduler] SIGTERM received — stopping cron job");
    job.stop();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("[Scheduler] SIGINT received — stopping cron job");
    job.stop();
    process.exit(0);
  });

  console.log("[Scheduler] ✅ Scheduler is running. Waiting for next trigger...\n");
  return job;
}

module.exports = { startScheduler };
