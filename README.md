# One A Day

One random unsolved LeetCode problem a day, solved by a model and submitted to the
account. Public dashboard: https://one-a-day.shounak.workers.dev

## How it runs

- **`src/worker.js`** — Cloudflare Worker. Every-minute cron drives a small KV state
  machine: pick → AI solve → submit → poll → record. One problem per day at 09:00 IST.
- **`.github/workflows/browser-submit.yml`** — manual-only fallback experiment. Its
  schedule is disabled: with a valid session the Worker submits directly (verified
  2026-11-24, Accepted 865/865). A fresh cloud Chromium gets stuck on Cloudflare's
  managed challenge, so this path is not currently reliable.
- **`scripts/cloud_submit.mjs`** — the cloud browser runner (unused unless triggered by hand).
- **`scripts/browser_submit.mjs`** — the old local runner. Kept for reference only;
  its Windows scheduled task ("OneADay Browser Submit") is disabled.

## Repository secrets

`LEETCODE_SESSION`, `CSRFTOKEN` — the account session cookies. **These must be set both
as GitHub secrets and as Worker secrets** (`npx wrangler secret put ...`). The Worker
needs them to submit directly; GitHub secrets are only used by the disabled fallback
runner.

`WORKER_URL`, `RUNNER_SECRET` — how the fallback runner reaches the Worker.

## When submissions start failing with "not signed in"

The session cookie expires. Refresh it:

1. Log in to https://leetcode.com in your browser.
2. Open DevTools (F12) → **Application** → **Storage** → **Cookies** → `https://leetcode.com`.
3. Copy the **Value** of `LEETCODE_SESSION` and `csrftoken`.
4. Update the GitHub secrets:
   ```powershell
   $s = Read-Host 'LEETCODE_SESSION' -AsSecureString
   $c = Read-Host 'CSRFTOKEN' -AsSecureString
   [System.Net.NetworkCredential]::new('', $s).Password | gh secret set LEETCODE_SESSION -R shounakjoshi88-a11y/one-a-day
   [System.Net.NetworkCredential]::new('', $c).Password | gh secret set CSRFTOKEN -R shounakjoshi88-a11y/one-a-day
   ```
5. Click "Retry today's problem" on the dashboard (needs the `TRIGGER_SECRET`), or wait
   for the next daily run.
