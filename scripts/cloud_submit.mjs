#!/usr/bin/env node
/**
 * Cloud browser submitter for One A Day.
 *
 * LeetCode's Cloudflare managed challenge blocks a plain fetch() from a
 * datacenter (the Worker), so the in-page submit has to run in a real browser.
 * This is the headless-in-the-cloud version of scripts/browser_submit.mjs:
 * GitHub Actions launches Chromium with the account cookies, asks the Worker
 * for a parked run, submits from inside leetcode.com, and posts the verdict
 * back. Nothing runs on the user's machine.
 *
 * Env: WORKER_URL, RUNNER_SECRET, LEETCODE_SESSION, CSRFTOKEN.
 */

import { chromium } from "playwright";

const WORKER = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const SECRET = process.env.RUNNER_SECRET || "";
const SESSION = process.env.LEETCODE_SESSION || "";
const CSRF = process.env.CSRFTOKEN || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EVAL_TIMEOUT_MS = 175000;

const log = (...a) => console.log(`${new Date().toISOString()} ${a.join(" ")}`);

async function api(path, init = {}) {
  const r = await fetch(`${WORKER}${path}`, {
    ...init,
    headers: { "x-runner-secret": SECRET, "content-type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** Same in-page submit the local runner uses, proven against LeetCode's own JS. */
function submitExpression(job) {
  const payload = { slug: job.slug, qid: Number(job.questionId), code: job.code };
  return `(async () => {
  const P = ${JSON.stringify(payload)};
  const csrf = () => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
  const gql = async (query) => (await fetch("/graphql/", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "x-csrftoken": csrf() },
    body: JSON.stringify({ query })
  })).json();

  const who = (await gql("query{userStatus{isSignedIn username}}")).data?.userStatus;
  if (!who || !who.isSignedIn) return { stage: "auth" };

  const r = await fetch("/problems/" + P.slug + "/submit/", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "x-csrftoken": csrf(), "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ lang: "python3", question_id: P.qid, typed_code: P.code })
  });
  const text = await r.text();
  if (r.status !== 200) return { stage: "submit", status: r.status, text: text.slice(0, 200) };
  let sid = null;
  try { sid = JSON.parse(text).submission_id; } catch { /* fall through */ }
  if (!sid) return { stage: "submit", status: 200, text: text.slice(0, 200) };

  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const v = await fetch("/submissions/detail/" + sid + "/check/", { credentials: "include" })
      .then((x) => (x.ok ? x.json() : { http: x.status })).catch(() => ({}));
    if (v.state === "SUCCESS" || v.state === "FINISHED") return { stage: "done", sid, verdict: v };
  }
  return { stage: "timeout", sid };
})()`;
}

/** Wait for Cloudflare's JS challenge to hand control back to the real page. */
async function waitForPage(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({
        title: document.title,
        body: (document.body?.innerText || "").slice(0, 400),
      }))
      .catch(() => ({ title: "", body: "" }));
    const challenged = /just a moment|checking your browser|cf-challenge/i.test(`${state.title} ${state.body}`);
    if (!challenged && state.body.length) return;
    await page.waitForTimeout(1500);
  }
  throw new Error("Cloudflare challenge did not clear in time");
}

async function main() {
  if (!WORKER || !SECRET || !SESSION || !CSRF) {
    throw new Error("missing WORKER_URL / RUNNER_SECRET / LEETCODE_SESSION / CSRFTOKEN");
  }

  const peek = await api("/api/pending?probe=1");
  if (!peek.pending) {
    log("no parked run");
    return;
  }
  const job = await api("/api/pending");
  if (!job.pending) {
    log("another runner claimed it first");
    return;
  }
  log(`job: #${job.questionId} ${job.slug} (attempt ${job.attempt}, ${job.track})`);

  const browser = await chromium.launch({
    headless: false, // xvfb-run in CI gives us a display; headful passes the challenge
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  let result;
  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    await context.addCookies([
      { name: "LEETCODE_SESSION", value: SESSION, domain: ".leetcode.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
      { name: "csrftoken", value: CSRF, domain: ".leetcode.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax" },
    ]);

    const page = await context.newPage();
    await page.goto(`https://leetcode.com/problems/${encodeURIComponent(job.slug)}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await waitForPage(page);

    for (let i = 0; i < 3; i++) {
      try {
        result = await Promise.race([
          page.evaluate(submitExpression(job)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("in-page submit timed out")), EVAL_TIMEOUT_MS)),
        ]);
        break;
      } catch (e) {
        if (/Execution context was destroyed|navigation/i.test(String(e)) && i < 2) {
          await page.waitForTimeout(2000);
          await waitForPage(page);
          continue;
        }
        throw e;
      }
    }
  } finally {
    await browser.close();
  }

  if (!result) throw new Error("submit produced no result");

  if (result.stage === "auth") {
    log("GitHub Actions browser is not signed in — refresh the LEETCODE_SESSION secret");
    await api("/api/verdict", {
      method: "POST",
      body: JSON.stringify({ error: "Cloud browser is not signed in to LeetCode — refresh LEETCODE_SESSION/CSRFTOKEN secrets" }),
    });
    return;
  }
  if (result.stage !== "done") {
    const msg =
      result.stage === "timeout"
        ? `judge did not finish within 2 min (submission ${result.sid})`
        : `browser submit failed: ${result.status} ${String(result.text || "").slice(0, 140)}`;
    log(`FAILED: ${msg}`);
    await api("/api/verdict", { method: "POST", body: JSON.stringify({ sid: result.sid || null, error: msg }) });
    return;
  }

  const v = result.verdict;
  log(`submission ${result.sid}: ${v.status_msg} (${v.total_correct}/${v.total_testcases})`);
  const back = await api("/api/verdict", {
    method: "POST",
    body: JSON.stringify({
      sid: result.sid,
      status_msg: v.status_msg,
      runtime_display: v.runtime_display ?? null,
      total_correct: v.total_correct ?? null,
      total_testcases: v.total_testcases ?? null,
      compile_error: v.compile_error ?? null,
      runtime_error: v.runtime_error ?? null,
      last_testcase: v.last_testcase ?? null,
      expected_output: v.expected_output ?? null,
      code_output: v.code_output ?? null,
    }),
  });
  log(`worker: ${JSON.stringify(back)}`);
}

main().catch((e) => {
  log(`FAILED: ${String(e).slice(0, 300)}`);
  process.exit(1);
});
