# One A Day

One random unsolved LeetCode problem a day, solved by a model and submitted to the
account. Public dashboard: https://one-a-day.shounak.workers.dev

## How it runs

- **`src/worker.js`** — Cloudflare Worker. Every-minute cron drives a small KV state
  machine: pick → AI solve → submit → poll → record. One problem per day at 09:00 IST.
- **`.github/workflows/browser-submit.yml`** — GitHub Actions, every 5 minutes. LeetCode
  challenges plain `fetch()` from datacenter IPs, so a real Chromium in the cloud picks
  up any run the Worker parks in `await_browser`, submits it from inside leetcode.com,
  and posts the verdict back. Nothing runs on the local machine.
- **`scripts/cloud_submit.mjs`** — the cloud browser runner.
- **`scripts/browser_submit.mjs`** — the old local runner. Kept for reference only;
  its Windows scheduled task ("OneADay Browser Submit") is disabled.

## Repository secrets

`LEETCODE_SESSION`, `CSRFTOKEN` — the account session cookies.
`WORKER_URL`, `RUNNER_SECRET` — how the runner reaches the Worker.

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
