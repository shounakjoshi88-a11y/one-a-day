#!/usr/bin/env node
/**
 * Browser submitter for One A Day.
 *
 * LeetCode answers a plain `fetch()` (Worker, CI, datacenter) with a Cloudflare
 * managed challenge: 403 + `cf-mitigated: challenge`. Nothing behind that
 * challenge is reachable, so the worker cannot submit or poll the judge itself.
 *
 * This runner does those calls inside the user's own Chrome — where the
 * challenge is already passed and the session is already signed in — using the
 * Browser Bridge CLI (`bbx`). It asks the Worker for a parked run, submits,
 * waits for the judge, and posts the verdict back.
 *
 * Env (machine-local, .env.runner): WORKER_URL, RUNNER_SECRET.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const BBX = process.platform === "win32" ? "bbx.cmd" : "bbx";

const envFile = join(ROOT, ".env.runner");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const WORKER = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const SECRET = process.env.RUNNER_SECRET || "";
const LOG_DIR = join(ROOT, "logs");

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "runner.log"), line + "\n");
  } catch {
    /* logging is best-effort */
  }
}

/* one runner at a time: the task fires every few minutes, a run can last ~2 min */
const LOCK = join(ROOT, ".runner.lock");
let hasLock = false;
try {
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 10 * 60e3) {
    process.exit(0);
  }
  writeFileSync(LOCK, String(process.pid));
  hasLock = true;
  process.on("exit", () => {
    if (!hasLock) return;
    try {
      unlinkSync(LOCK);
    } catch {
      /* already gone */
    }
  });
} catch {
  /* never block a submission over a lock */
}

/* ---------------- bridge + worker plumbing ---------------- */

function bbx(args, stdinJson, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(BBX, args, { shell: process.platform === "win32", windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("bbx timed out"));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`bbx exit ${code}: ${(err || out).slice(0, 200)}`));
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        reject(new Error(`unparsable bbx output: ${out.slice(0, 200)}`));
      }
    });
    if (stdinJson !== undefined) p.stdin.write(stdinJson);
    p.stdin.end();
  });
}

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

/** Find a ready LeetCode tab, creating one if the window has none. */
async function ensureTab() {
  const list = await bbx(["call", "tabs.list", "{}"]);
  const ready = (list.tabs || []).find((t) => (t.url || "").startsWith("https://leetcode.com/"));
  if (ready) return { tabId: ready.tabId, created: false };

  const made = await bbx(["call", "tabs.create", JSON.stringify({ url: "https://leetcode.com/", active: false })]);
  const tabId = made.tabId ?? made.evidence?.tabId;
  if (!tabId) throw new Error("could not create a LeetCode tab");
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await bbx(["call", "tabs.list", "{}"]);
    const t = (now.tabs || []).find((x) => x.tabId === tabId);
    if (t && (t.url || "").startsWith("https://leetcode.com/")) return { tabId, created: true };
  }
  return { tabId, created: true };
}

/* ---------------- the in-page submit ---------------- */

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

async function main() {
  if (!WORKER || !SECRET) {
    log("missing WORKER_URL or RUNNER_SECRET; nothing to do");
    return;
  }

  const peek = await api("/api/pending?probe=1");
  if (!peek.pending) return; // quiet: this runs every few minutes

  const job = await api("/api/pending");
  if (!job.pending) {
    log("another runner claimed it first");
    return;
  }
  log(`job: #${job.questionId} ${job.slug} (attempt ${job.attempt}, ${job.track})`);

  const tab = await ensureTab();
  let result;
  try {
    const raw = await bbx(
      ["call", "--tab", String(tab.tabId), "page.evaluate", "-"],
      JSON.stringify({ expression: submitExpression(job), awaitPromise: true, returnByValue: true, timeoutMs: 170000 }),
      180000
    );
    result = raw.value ?? raw;
  } finally {
    if (tab.created) {
      await bbx(["call", "tabs.close", JSON.stringify({ tabId: tab.tabId })]).catch(() => {});
    }
  }

  if (result.stage === "auth") {
    log("NOT SIGNED IN in Chrome — log in to leetcode.com and the next tick will submit");
    await api("/api/verdict", {
      method: "POST",
      body: JSON.stringify({ error: "Chrome is not signed in to LeetCode — log in and it will retry" }),
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
