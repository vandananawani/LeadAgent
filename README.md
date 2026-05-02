# CFO Lead Generation Agent

Automated daily pipeline: Apify (Google Search) → Gemini AI → Google Sheets
Generates ~100 qualified CFO/Finance leads per day. Fully cloud-based.

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your API keys

# 3. Test run (runs pipeline once and exits)
node index.js --run-once

# 4. Production (starts scheduler, runs daily at 6 AM UTC)
npm start
```

---

## Environment Variables

| Variable | Where to get it |
|---|---|
| APIFY_API_TOKEN | apify.com → Settings → Integrations |
| GEMINI_API_KEY | aistudio.google.com → Get API Key |
| GOOGLE_SHEETS_ID | From your Sheet URL |
| GOOGLE_SERVICE_ACCOUNT_JSON | Google Cloud Console → Service Account → JSON key |

---

## Google Service Account Setup

1. Go to console.cloud.google.com
2. Create a new project (or use existing)
3. Enable "Google Sheets API"
4. IAM & Admin → Service Accounts → Create Service Account
5. Grant role: "Editor"
6. Keys tab → Add Key → JSON → Download
7. Paste entire JSON content as GOOGLE_SERVICE_ACCOUNT_JSON value
8. **IMPORTANT**: Share your Google Sheet with the service account email address

---

## Deploy on Render (Free)

1. Push this project to a GitHub repository
2. Go to render.com → New → Background Worker
3. Connect your GitHub repo
4. Set Build Command: `npm install`
5. Set Start Command: `node index.js`
6. Add environment variables in Render's dashboard
7. Deploy — it runs 24/7 and wakes daily at cron time

### Render Free Tier Note
Render free tier spins down after 15 min of inactivity for web services.
Use a **Background Worker** (not Web Service) — it stays alive permanently.

### IST Timing
Render servers run UTC. To run at 6 AM IST, use:
```
CRON_SCHEDULE=30 0 * * *
```
(0:30 UTC = 6:00 AM IST)

---

## Project Structure

```
cfo-lead-agent/
├── src/
│   ├── apify.js      — Apify scraping + polling
│   ├── gemini.js     — Gemini AI processing + batching
│   ├── sheets.js     — Google Sheets write + dedup
│   ├── processor.js  — Pipeline orchestration
│   └── scheduler.js  — node-cron daily trigger
├── index.js          — Entry point + env validation
├── package.json
└── .env.example
```

---

## Cron Schedule Examples

| Schedule | Meaning |
|---|---|
| `0 6 * * *` | 6:00 AM UTC (11:30 AM IST) |
| `30 0 * * *` | 12:30 AM UTC (6:00 AM IST) |
| `0 6 * * 1-5` | Weekdays only, 6 AM UTC |
| `0 */12 * * *` | Twice daily |
