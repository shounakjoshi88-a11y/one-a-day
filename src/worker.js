/**
 * One A Day — autonomous daily coding-problem bot (Cloudflare Workers, free plan).
 *
 * Free-plan limits force a step-machine design: 10 ms CPU per invocation and
 * ~30 s of waitUntil after an HTTP response make a monolithic solve loop
 * impossible. So an every-minute cron drives a tiny state machine in KV:
 *
 *   idle -> pick -> ai -> submit -> poll --(Accepted)--> record -> idle
 *                                   ^                  |
 *                                   +----(failed)------+   (up to MAX_ATTEMPTS)
 *
 * Each invocation executes EXACTLY ONE small step (~1-2 ms CPU), persists
 * progress, and exits. The next cron tick (60 s later) continues. Steps are
 * idempotent and resumable, so any crash just delays the run to the next tick.
 *
 * Daily gate: first tick between 03:30 UTC (09:00 IST) and 18:30 UTC (00:00 IST
 * next day) that finds no record for today's IST date starts the run. One
 * problem per day, never repeated.
 * A second, separate track follows the day's headline run and solves whatever
 * problem the site is featuring that day; it keeps its own record keys so the
 * public day record, history and dashboard are untouched.
 * The problem pool comes from the GitHub repo's state/problems.json (compact,
 * already carries per-problem account-AC flags); refreshed weekly. Recent-AC
 * slugs from LeetCode are cross-checked at pick time so manually-solved
 * problems are never re-picked even when the pool file is days old.
 *
 * Bindings: STATE (KV), AI (Workers AI). Secrets: LEETCODE_SESSION, CSRFTOKEN,
 * TRIGGER_SECRET. Stops after 2026-12-31.
 */

const LC = "https://leetcode.com";
const END_DATE = "2026-12-31"; // IST date after which the bot goes dormant
const START_UTC_MIN = 3 * 60 + 30; // 03:30 UTC = 09:00 IST, when the daily run may start
const IST_MIDNIGHT_UTC_MIN = 18 * 60 + 30; // 18:30 UTC = 00:00 IST: the IST date rolls here
const MAX_ATTEMPTS = 3; // AI solve attempts per problem (Workers AI free-tier neuron budget)
const FEATURED_ATTEMPTS = 3; // second track gets the same cap as the headline run
const MAX_POLLS = 10; // per-minute judge polls per submission before treating it as a timeout
const WEEK_MS = 7 * 86400e3; // pool cache TTL + re-attempt cooldown
const RUN_STALE_MS = 60 * 60e3; // a run older than this is force-finished as failed
const AWAIT_BROWSER_MS = 8 * 3600e3; // a parked run waits this long for the browser runner
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DIFF_NAMES = { 1: "Easy", 2: "Medium", 3: "Hard" };
const DIFF_LEVELS = { Easy: 1, Medium: 2, Hard: 3 };
const POOL_REPO_URL =
  "https://raw.githubusercontent.com/shounakjoshi88-a11y/one-a-day/main/state/problems.json";

/* ---------------- time helpers ---------------- */

/** Current date in IST as "YYYY-MM-DD". */
function istDate(ts = Date.now()) {
  return new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- leetcode API ---------------- */

function lcHeaders(env, slug) {
  return {
    cookie: `LEETCODE_SESSION=${env.LEETCODE_SESSION}; csrftoken=${env.CSRFTOKEN}`,
    "x-csrftoken": env.CSRFTOKEN,
    "x-requested-with": "XMLHttpRequest",
    "user-agent": UA,
    referer: slug ? `${LC}/problems/${slug}/` : `${LC}/`,
    origin: LC,
    accept: "application/json, text/plain, */*",
  };
}

async function gql(env, query, variables) {
  const r = await fetch(`${LC}/graphql/`, {
    method: "POST",
    headers: { ...lcHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`graphql ${r.status}: ${body.slice(0, 150)}`);
  }
  const j = await r.json();
  if (j.errors) throw new Error("graphql: " + JSON.stringify(j.errors).slice(0, 200));
  return j;
}

/** Compact problem pool, refreshed weekly from the repo's committed pool file. */
async function getProblemPool(env) {
  const cached = await env.STATE.get("problems:list", "json");
  // 30-day TTL: the pool is a candidate list; "already solved" freshness comes
  // from the per-problem ac flags plus the recent-AC guard at pick time, so a
  // slightly stale pool is safe and a weekly refetch would just repeat work.
  if (cached?.problems?.length && Date.now() - cached.fetchedAt < 30 * 86400e3) return cached;

  let pool = null;
  try {
    const r = await fetch(POOL_REPO_URL, { headers: { "user-agent": UA }, cf: { cacheTtl: 600 } });
    if (r.ok) {
      const j = await r.json();
      // respect the repo file's own fetch date so the TTL tracks GH's refresh
      if (j?.problems?.length) pool = { fetchedAt: j.fetchedAt || Date.now(), problems: j.problems };
    }
  } catch {
    /* repo unavailable — fall through to stale KV */
  }
  if (!pool && cached?.problems?.length) {
    console.log("[pool] repo fetch failed; using stale KV pool");
    return cached;
  }
  if (!pool) throw new Error("no problem pool available");
  await env.STATE.put("problems:list", JSON.stringify(pool));
  return pool;
}

/** Slugs of the account's most recent Accepted submissions (freshness guard). */
async function getRecentAcSlugs(env) {
  try {
    const j = await gql(
      env,
      `query { matchedUser { recentAcSubmissionList(limit: 50) { titleSlug } } }`,
      {}
    );
    return (j.data?.matchedUser?.recentAcSubmissionList || []).map((s) => s.titleSlug);
  } catch {
    return []; // guard is best-effort only
  }
}

/** The problem the site is featuring right now (used by the second track). */
async function getFeatured(env) {
  const j = await gql(
    env,
    `query { activeDailyCodingChallengeQuestion {
      date question { titleSlug questionFrontendId difficulty }
    } }`,
    {}
  );
  const f = j.data?.activeDailyCodingChallengeQuestion;
  if (!f?.question?.titleSlug) throw new Error("no featured problem available");
  return f;
}

/** Question detail: statement + python3 starter code. */
async function getQuestion(env, slug) {
  const j = await gql(
    env,
    `query q($s: String!) { question(titleSlug: $s) {
      questionId questionFrontendId title difficulty content
      codeSnippets { lang langSlug code }
    } }`,
    { s: slug }
  );
  const q = j.data?.question;
  if (!q) throw new Error(`question ${slug} not found or premium`);
  return q;
}

/**
 * Submit python3 code; returns submission id.
 *
 * LeetCode sits behind Cloudflare managed-challenge, which answers a plain
 * non-browser fetch with `403` + `cf-mitigated: challenge`. A 403 is therefore
 * not an auth verdict — it means the request never reached the judge, so the
 * error is tagged `challenge` and the run is handed to the browser runner
 * (see scripts/browser_submit.mjs) instead of being recorded as a failed day.
 */
async function submitSolution(env, slug, questionId, code) {
  let last = "";
  let challenged = false;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${LC}/problems/${slug}/submit/`, {
      method: "POST",
      headers: { ...lcHeaders(env, slug), "content-type": "application/json" },
      body: JSON.stringify({ lang: "python3", question_id: parseInt(questionId, 10), typed_code: code }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j?.submission_id) return j.submission_id;
      last = `submit 200 but no submission_id: ${JSON.stringify(j).slice(0, 120)}`;
      await sleep(4000);
      continue;
    }
    const body = await r.text().catch(() => "");
    // A 403 means "the judge didn't say no" here: from the datacenter it is
    // Cloudflare's managed challenge, from the browser it is "User is not
    // authenticated". Either way, park the run — the browser runner decides
    // whether it can actually submit (it is signed in) or not.
    const mitigated = r.headers.get("cf-mitigated") || "";
    const looksLikeChallenge = /Just a moment|challenge-platform|cf_chl/i.test(body) || mitigated.includes("challenge");
    if (r.status === 403 || looksLikeChallenge) challenged = true;
    last = `submit ${r.status}${challenged ? " (cloudflare challenge)" : ""}: ${body.replace(/\s+/g, " ").slice(0, 140)}`;
    if (r.status === 429) {
      await sleep(8000);
      continue;
    }
    if (r.status === 403 || r.status === 503 || r.status >= 500) {
      await sleep(1500);
      continue;
    }
    throw new Error(last);
  }
  const err = new Error(last || "submit: no submission id");
  if (challenged) err.challenge = true;
  throw err;
}

/** One judge poll. Returns the verdict object when judging reached a terminal state. */
async function checkOnce(env, sid) {
  const r = await fetch(`${LC}/submissions/detail/${sid}/check/`, { headers: lcHeaders(env) });
  if (!r.ok) return null;
  const j = await r.json();
  // LeetCode marks completed judging with state "SUCCESS" (older "FINISHED" kept for safety)
  if (j.state === "SUCCESS" || j.state === "FINISHED") return j;
  return null;
}

/* ---------------- AI solving ---------------- */

function htmlToText(html) {
  return html
    .replace(/<pre>[\s\S]*?<\/pre>/gi, (m) => "\n\n" + m.replace(/<[^>]+>/g, "") + "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function buildPrompt(statement, starter, feedback, prevCode) {
  let p =
    `Solve the following competitive programming problem in Python 3.\n\n` +
    `PROBLEM:\n${statement.slice(0, 8000)}\n\n` +
    `CODE TEMPLATE (must keep the same class and method names):\n${starter}\n\n` +
    `RULES:\n` +
    `- Output ONLY the complete Python 3 code, no markdown fences, no prose.\n` +
    `- No imports unless absolutely necessary.\n` +
    `- At most 5 very short comments at the trickiest lines (brevity matters — long answers get truncated).\n` +
    `- Must be efficient enough to satisfy the constraints.\n`;
  if (feedback) {
    p +=
      `\nYour previous attempt FAILED the judge with this feedback:\n${feedback.slice(0, 1200)}\n\n` +
      `PREVIOUS CODE:\n${prevCode}\n\n` +
      `Return a corrected, complete solution only.\n`;
  }
  return p;
}

async function askAI(env, prompt) {
  const models = ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
  let lastErr = null;
  for (const model of models) {
    try {
      const res = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 3000,
      });
      const text = res.response || res.result?.response || "";
      if (text && text.trim()) return text;
      lastErr = new Error("empty AI response");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("AI failed");
}

function extractCode(text) {
  const fence = text.match(/```(?:python|py)?\s*([\s\S]*?)```/);
  let code = fence ? fence[1] : text;
  const idx = code.indexOf("class Solution");
  if (idx > 0) code = code.slice(idx);
  if (idx === -1 && code.trim().length < 10) throw new Error("AI produced no code");
  return code.trim() + "\n";
}

/** Human-readable failure summary to feed back to the model. */
function describeFailure(v) {
  if (!v) return "The judge took too long; treat this as an unknown failure and return a more robust/faster solution.";
  const parts = [];
  if (v.compile_error) parts.push("Compile error:\n" + String(v.compile_error).slice(0, 500));
  if (v.runtime_error) parts.push("Runtime error:\n" + String(v.runtime_error).slice(0, 500));
  if (v.last_testcase) parts.push("Failed input:\n" + String(v.last_testcase).slice(0, 300));
  if (v.expected_output !== undefined && v.expected_output !== null)
    parts.push("Expected output: " + String(v.expected_output).slice(0, 300));
  if (v.code_output)
    parts.push(
      "Your output: " +
        String(Array.isArray(v.code_output) ? v.code_output.join(" | ") : v.code_output).slice(0, 300)
    );
  parts.push(`Status: ${v.status_msg} (${v.total_correct}/${v.total_testcases} tests passed)`);
  return parts.join("\n");
}

/* ---------------- pick ---------------- */

/**
 * Random pick among free + not-solved problems, weighted by difficulty
 * (~30% Easy / 45% Medium / 25% Hard). Skips problems attempted in the
 * last 7 days so a failure doesn't hog tomorrow's slot.
 */
function pickProblem(pool, solved, attempted, recentAc) {
  const cutoff = Date.now() - WEEK_MS;
  const byDiff = { 1: [], 2: [], 3: [] };
  const solvedSet = new Set([...solved, ...recentAc]);
  for (const p of pool.problems) {
    if (p.p || p.ac || solvedSet.has(p.s)) continue;
    if (attempted[p.s] && attempted[p.s] > cutoff) continue;
    (byDiff[p.d] || byDiff[2]).push(p);
  }
  const weights = { 1: 0.3, 2: 0.45, 3: 0.25 };
  const present = [1, 2, 3].filter((d) => byDiff[d].length);
  if (!present.length) return null;
  const total = present.reduce((a, d) => a + weights[d], 0);
  let r = Math.random() * total;
  let chosen = present[0];
  for (const d of present) {
    r -= weights[d];
    if (r <= 0) {
      chosen = d;
      break;
    }
  }
  return byDiff[chosen][Math.floor(Math.random() * byDiff[chosen].length)];
}

/* ---------------- state machine ---------------- */

async function saveRun(env, s) {
  await env.STATE.put("run:state", JSON.stringify(s));
}

/** Terminal step: persist the day's record everywhere and go idle. */
async function finishRun(env, s, extra) {
  const featured = s.track === "featured";
  const record = {
    date: s.date,
    slug: s.slug || null,
    frontendId: s.f || null,
    title: s.title || s.slug || null,
    difficulty: s.d ? DIFF_NAMES[s.d] : null,
    accepted: !!s.accepted,
    attempts: (s.logs || []).length,
    log: s.logs || [],
    runtime: s.runtime || null,
    submissionId: s.sid || null,
    code: s.code || null,
    error: s.error || null,
    startedAt: s.startedAt,
    finishedAt: new Date().toISOString(),
    ...(featured ? { track: "featured", featuredDate: s.featuredDate || null } : {}),
    ...extra,
  };

  const solved = (await env.STATE.get("solved:list", "json")) || [];
  const attempted = (await env.STATE.get("attempted:map", "json")) || {};
  if (!s.noCooldown && record.attempts > 0 && record.slug) attempted[record.slug] = Date.now();
  if (record.accepted && record.slug && !solved.includes(record.slug)) solved.push(record.slug);

  const ops = [
    env.STATE.put(`${featured ? "featured" : "today"}:${s.date}`, JSON.stringify(record)),
    env.STATE.put("attempted:map", JSON.stringify(attempted)),
    env.STATE.put("solved:list", JSON.stringify(solved)),
  ];
  // a retry for the same date replaces that day's row instead of stacking up
  const withRecord = (list) => [...(list || []).filter((r) => r.date !== record.date), record].slice(-120);
  if (featured) {
    ops.push(
      env.STATE.get("featured:history", "json").then((h) =>
        env.STATE.put("featured:history", JSON.stringify(withRecord(h)))
      )
    );
  } else {
    ops.push(
      env.STATE.get("history:list", "json").then((h) =>
        env.STATE.put("history:list", JSON.stringify(withRecord(h)))
      )
    );
  }
  ops.push(env.STATE.delete("run:state"));
  await Promise.all(ops);
  console.log(
    `[run] ${s.date} ${s.slug}${featured ? " (featured)" : ""} -> ${record.accepted ? "ACCEPTED" : "failed"} (${record.attempts} attempts)`
  );
}

/** Fold one judge verdict into the run state (cron poll and browser runner both land here). */
async function applyVerdict(env, s, verdict) {
  const cap = s.maxAttempts || MAX_ATTEMPTS;
  const accepted = verdict?.status_msg === "Accepted";
  s.runtime = verdict?.runtime_display || null;
  s.logs.push({
    attempt: s.attempt,
    status: verdict?.status_msg || "unknown",
    correct: verdict?.total_correct ?? null,
    total: verdict?.total_testcases ?? null,
  });
  console.log(
    `[run] judge attempt ${s.attempt}: ${verdict?.status_msg} (${verdict?.total_correct}/${verdict?.total_testcases})`
  );
  if (accepted) {
    s.accepted = true;
    s.phase = "record";
  } else {
    s.feedback = describeFailure(verdict);
    s.accepted = false;
    if (s.attempt >= cap) s.phase = "record";
    else {
      s.attempt++;
      s.phase = "ai";
    }
  }
  await saveRun(env, s);
}

/** Execute exactly one machine step. `s` is the persisted run-state. */
async function step(env, s) {
  // stale-run guard: a run stuck for over an hour is force-finished. A run
  // parked for the browser runner has its own, longer deadline.
  const stale = s.phase === "await_browser" ? Date.now() > (s.awaitUntil || 0) : Date.now() - new Date(s.startedAt).getTime() > RUN_STALE_MS;
  if (stale && s.phase !== "record") {
    s.error =
      s.phase === "await_browser"
        ? "no browser runner picked this submission up in time"
        : `run stalled in phase ${s.phase}; force-finished`;
    s.noCooldown = true;
    console.log(`[run] stale: ${s.error}`);
    await finishRun(env, s, {});
    return;
  }

  switch (s.phase) {
    case "pick": {
      const cap = s.maxAttempts || MAX_ATTEMPTS;
      // Observational only. The stored cookies are often stale while the
      // browser is still signed in, and the browser runner owns the submit.
      // A genuinely dead session surfaces as the 403 at submit, where the
      // runner reports "Chrome is not signed in...".
      try {
        const who = (await gql(env, `query { userStatus { isSignedIn username } }`)).data?.userStatus;
        console.log(`[run] signed-in check: ${who?.username ?? "unknown"}`);
      } catch {
        /* ignore — the submit step decides */
      }
      let pick = null;
      let q = null;
      try {
        if (s.retrySlug) {
          // manual retry: same problem as the day's failed record, no re-pick
          q = await getQuestion(env, s.retrySlug);
          pick = { s: s.retrySlug, f: q.questionFrontendId, d: DIFF_LEVELS[q.difficulty] || 2 };
        } else if (s.track === "featured") {
          // second track: the site decides the problem, so no pool / weighting
          const feat = await getFeatured(env);
          q = await getQuestion(env, feat.question.titleSlug);
          pick = {
            s: q.titleSlug || feat.question.titleSlug,
            f: q.questionFrontendId ?? feat.question.questionFrontendId,
            d: DIFF_LEVELS[q.difficulty] || 2,
          };
          s.featuredDate = feat.date;
        } else {
          const pool = await getProblemPool(env);
          const solved = (await env.STATE.get("solved:list", "json")) || [];
          const attempted = (await env.STATE.get("attempted:map", "json")) || {};
          const recentAc = await getRecentAcSlugs(env);
          pick = pickProblem(pool, solved, attempted, recentAc);
          if (!pick) {
            s.error = "no eligible problems left — pool exhausted";
            s.phase = "record";
            await saveRun(env, s);
            return;
          }
          q = await getQuestion(env, pick.s);
        }
      } catch (e) {
        s.error = `${s.track || "random"} pick failed: ${String(e).slice(0, 220)}`;
        console.log(`[run] ${s.error}`);
        s.phase = "record";
        await saveRun(env, s);
        return;
      }
      s.slug = pick.s;
      s.f = q.questionFrontendId ?? pick.f;
      s.title = q.title;
      s.d = pick.d;
      s.qid = q.questionId;
      s.statement = htmlToText(q.content || "").slice(0, 9000);
      s.starter = (q.codeSnippets || []).find((c) => c.langSlug === "python3")?.code || "";
      s.logs = [];
      s.attempt = 1;
      s.maxAttempts = s.track === "featured" ? FEATURED_ATTEMPTS : cap;
      s.phase = "ai";
      console.log(`[run] ${s.date} picked #${s.f} ${s.slug} (${DIFF_NAMES[s.d]})`);
      await saveRun(env, s);
      return;
    }

    case "ai": {
      const cap = s.maxAttempts || MAX_ATTEMPTS;
      let text;
      try {
        text = await askAI(env, buildPrompt(s.statement, s.starter, s.feedback, s.prevCode));
        s.code = extractCode(text);
      } catch (e) {
        const msg = String(e).slice(0, 250);
        s.logs.push({ attempt: s.attempt, status: /no code|parse/i.test(msg) ? "parse_error" : "ai_error", error: msg });
        console.log(`[run] ai error on attempt ${s.attempt}: ${msg}`);
        s.phase = s.attempt >= cap ? "record" : "ai";
        s.attempt = s.attempt >= cap ? s.attempt : s.attempt + 1;
        await saveRun(env, s);
        return;
      }
      s.phase = "submit";
      await saveRun(env, s);
      return;
    }

    case "submit": {
      try {
        s.sid = await submitSolution(env, s.slug, s.qid, s.code);
      } catch (e) {
        const msg = String(e).slice(0, 250);
        s.logs.push({ attempt: s.attempt, status: "submit_error", error: msg });
        console.log(`[run] submit error: ${msg}`);
        if (e && e.challenge) {
          // The judge was never reached: park the run and let the browser
          // runner (real Chromium, passes the challenge) submit it instead.
          s.phase = "await_browser";
          s.awaitUntil = Date.now() + AWAIT_BROWSER_MS;
          s.browserNote = "handed to the browser runner";
          await saveRun(env, s);
          return;
        }
        s.phase = "record";
        await saveRun(env, s);
        return;
      }
      s.prevCode = s.code;
      s.polls = 0;
      s.phase = "poll";
      console.log(`[run] submitted attempt ${s.attempt} sid=${s.sid}`);
      await saveRun(env, s);
      return;
    }

    case "poll": {
      let verdict = null;
      try {
        verdict = await checkOnce(env, s.sid);
      } catch {
        verdict = null;
      }
      if (!verdict) {
        const cap = s.maxAttempts || MAX_ATTEMPTS;
        s.polls = (s.polls || 0) + 1;
        if (s.polls < MAX_POLLS) {
          await saveRun(env, s); // stay in poll; next tick re-checks
          return;
        }
        s.logs.push({ attempt: s.attempt, status: "judge_timeout" });
        s.feedback = describeFailure(null);
        s.accepted = false;
        if (s.attempt >= cap) {
          s.phase = "record";
        } else {
          s.attempt++;
          s.phase = "ai";
        }
        await saveRun(env, s);
        return;
      }
      await applyVerdict(env, s, verdict);
      return;
    }

    case "await_browser": {
      // Parked: LeetCode challenged this network, so a real browser submits it.
      // No KV write here — a 60 s cron tick would burn the free write quota.
      return;
    }

    case "record": {
      await finishRun(env, s, {});
      return;
    }

    default: {
      s.error = `unknown phase ${s.phase}; force-finished`;
      console.log(`[run] ${s.error}`);
      await finishRun(env, s, {});
      return;
    }
  }
}

/** Called by the cron and by /run. Starts a run when the day's gate allows. */
async function tick(env, force = false) {
  const date = istDate();
  if (date > END_DATE) return { skipped: "season-over", date };

  const existing = await env.STATE.get("run:state", "json");
  if (existing) {
    await step(env, existing);
    return { stepped: existing.phase, date };
  }

  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const todayRecord = await env.STATE.get(`today:${date}`, "json");
  const featuredRecord = await env.STATE.get(`featured:${date}`, "json");

  // order of work each day: headline run first, then the featured track
  let track = todayRecord ? (featuredRecord ? null : "featured") : "random";
  if (force) track = "random"; // force always re-runs the headline track
  if (!track) return { skipped: "already-ran-today", date };
  // Only the 09:00-23:59 IST stretch still belongs to this IST date: the date
  // rolls at 18:30 UTC, so gating on "past 03:30 UTC" alone would fire at
  // 00:00 IST and solve a day early.
  if (!force && (nowMin < START_UTC_MIN || nowMin >= IST_MIDNIGHT_UTC_MIN)) {
    return { skipped: "outside-09:00-ist-window", date };
  }

  const s = {
    date,
    track,
    phase: "pick",
    startedAt: new Date().toISOString(),
    logs: [],
  };
  await env.STATE.put("run:state", JSON.stringify(s));
  console.log(`[run] ${date} ${track} run started (force=${force})`);
  return { started: true, date, track };
}

/* ---------------- manual trigger ---------------- */

/**
 * Start a run immediately (bypassing the daily gate) and execute the cheap
 * steps inside the request — pick/ai/submit take seconds, not minutes. The
 * judge poll needs one cron tick per check, so the tick machine finishes it.
 */
async function startManual(env, track) {
  const date = istDate();
  const existing = await env.STATE.get("run:state", "json");
  if (existing) {
    return { busy: true, phase: existing.phase, track: existing.track || "random", date: existing.date };
  }

  const prev = await env.STATE.get(
    `${track === "featured" ? "featured" : "today"}:${date}`,
    "json"
  );
  const s = {
    date,
    track,
    phase: "pick",
    startedAt: new Date().toISOString(),
    logs: [],
    ...(prev?.slug ? { retrySlug: prev.slug } : {}), // retry the day's own problem, not a fresh pick
  };
  await env.STATE.put("run:state", JSON.stringify(s));
  console.log(`[manual] ${date} ${track} run started`);

  for (let i = 0; i < 4; i++) {
    const cur = await env.STATE.get("run:state", "json");
    if (!cur || cur.phase === "poll") break;
    await step(env, cur);
  }

  const left = await env.STATE.get("run:state", "json");
  const rec = await env.STATE.get(`${track === "featured" ? "featured" : "today"}:${date}`, "json");
  return {
    started: true,
    track,
    date,
    phase: left ? left.phase : "done",
    slug: (left || rec)?.slug || null,
    frontendId: (left && left.f) || rec?.frontendId || null,
    accepted: left ? null : !!rec?.accepted,
    error: (left && left.error) || rec?.error || null,
  };
}

/* ---------------- dashboard ---------------- */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function computeStreak(history) {
  const accepted = new Set(history.filter((h) => h.accepted).map((h) => h.date));
  let ts = Date.now() + 5.5 * 3600e3;
  if (!accepted.has(new Date(ts).toISOString().slice(0, 10))) ts -= 86400e3;
  let streak = 0;
  while (accepted.has(new Date(ts).toISOString().slice(0, 10))) {
    streak++;
    ts -= 86400e3;
  }
  return streak;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayAndMonth = (d) => {
  const [, m, day] = String(d || "").split("-");
  return m ? `${Number(day)} ${MONTHS[Number(m) - 1]}` : String(d || "");
};
const fullDate = (d) => {
  const [y, m, day] = String(d || "").split("-");
  return m ? `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}` : String(d || "");
};
const thousands = (n) => (n == null ? "" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const STATUS = {
  submit_error: "Submission rejected",
  ai_error: "Model did not answer",
  parse_error: "Model reply was not code",
  judge_timeout: "Judge timed out",
  "Wrong Answer": "Wrong answer",
  "Time Limit Exceeded": "Time limit exceeded",
  "Runtime Error": "Runtime error",
  "Compile Error": "Compile error",
  "Memory Limit Exceeded": "Memory limit exceeded",
};
const attemptsText = (n) => (n ? `, ${n} attempt${n === 1 ? "" : "s"}` : "");

/** One sentence saying what actually happened, for the run block. */
function outcomeLine(rec) {
  if (rec.error) return rec.error;
  if (!rec.log || !rec.log.length) return "No verdict recorded";
  const last = rec.log[rec.log.length - 1];
  if (last.status === "Accepted") return rec.runtime ? `Accepted in ${rec.runtime}` : "Accepted";
  const label = STATUS[last.status] || String(last.status || "Unknown verdict").toLowerCase();
  if (last.error) return `${label}. ${last.error}`;
  if (last.correct != null) {
    return `${label} on ${thousands(last.correct)} of ${thousands(last.total)} tests`;
  }
  return label;
}

function renderDashboard({ today, featured, history }) {
  const now = new Date();
  const date = istDate(now.getTime());
  const daysLeft = Math.max(
    0,
    Math.round((new Date(END_DATE + "T00:00:00Z") - new Date(date + "T00:00:00Z")) / 86400e3)
  );
  const acceptedCount = history.filter((h) => h.accepted).length;
  const streak = computeStreak(history);
  const seasonOver = date > END_DATE;

  /** A run block: label, verdict as the focal point, then the quiet detail. */
  const runBlock = (rec, label, id) => {
    if (!rec) {
      return `
      <article class="run run--idle" aria-labelledby="${id}">
        <h2 id="${id}">${label}</h2>
        <p class="verdict">Not run yet</p>
        <p class="note">${
          label === "Daily challenge"
            ? "Follows the day's problem, a minute or so later."
            : "The 9:00 IST run has not happened yet."
        }</p>
      </article>`;
    }
    return `
      <article class="run run--${rec.accepted ? "ok" : "bad"}" aria-labelledby="${id}">
        <h2 id="${id}">${label}</h2>
        <p class="verdict">${rec.accepted ? "Accepted" : "Not accepted"}</p>
        <p class="run-title"><a href="https://leetcode.com/problems/${esc(rec.slug)}/" target="_blank" rel="noopener">#${esc(
          rec.frontendId
        )} ${esc(rec.title)}</a><span class="diff">${esc(rec.difficulty || "")}</span></p>
        <p class="note">${esc(outcomeLine(rec))}${attemptsText(rec.attempts)}.</p>
        <p class="run-links"><a href="https://leetcode.com/problems/${esc(rec.slug)}/" target="_blank" rel="noopener">Problem</a>${
          rec.submissionId
            ? `<a href="https://leetcode.com/submissions/detail/${esc(rec.submissionId)}/" target="_blank" rel="noopener">Submission</a>`
            : ""
        }</p>
        ${rec.code ? `<details><summary>Show solution</summary><pre>${esc(rec.code)}</pre></details>` : ""}
      </article>`;
  };

  const rows = history
    .slice()
    .reverse()
    .slice(0, 30)
    .map(
      (h) => `<li>
        <time datetime="${esc(h.date)}">${esc(dayAndMonth(h.date))}</time>
        <a class="h-title" href="https://leetcode.com/problems/${esc(h.slug)}/" target="_blank" rel="noopener">#${esc(
          h.frontendId
        )} ${esc(h.title)}</a>
        <span class="h-diff">${esc(h.difficulty || "")}</span>
        <span class="h-result ${h.accepted ? "is-ok" : "is-bad"}">${h.accepted ? "Accepted" : "Not accepted"}</span>
      </li>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="600">
<title>One A Day</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    color-scheme: light dark;
    --paper: #f7f5f1;
    --paper-2: #fdfcfa;
    --ink: #1c1b18;
    --ink-2: #55524a;
    --ink-3: #6b675e;
    --rule: rgba(28, 27, 24, .14);
    --rule-soft: rgba(28, 27, 24, .07);
    --accent: #26565f;
    --accent-hover: #1c454d;
    --on-accent: #fdfcfa;
    --success: #1f6b45;
    --danger: #a02d2d;

    --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace;

    --fs-xs: 13px;   /* labels, meta */
    --fs-sm: 14px;   /* secondary copy */
    --fs-base: 15px; /* body */
    --fs-md: 17px;   /* problem titles */
    --fs-xl: 28px;   /* verdict */
    --fs-display: clamp(26px, 3.4vw, 32px);

    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px;
    --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px;
    --r-sm: 8px; --r-md: 10px;
    --fast: 140ms; --base: 280ms; --ease: cubic-bezier(.2, .7, .2, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #161514;
      --paper-2: #1e1d1b;
      --ink: #ece8e1;
      --ink-2: #b6b1a7;
      --ink-3: #8d887e;
      --rule: rgba(236, 232, 225, .16);
      --rule-soft: rgba(236, 232, 225, .08);
      --accent: #8fbcc4;
      --accent-hover: #a6cdd4;
      --on-accent: #10262b;
      --success: #6dbf92;
      --danger: #e39090;
    }
  }

  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: var(--fs-base)/1.55 var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; }

  .shell { max-width: 1040px; margin: 0 auto; padding: var(--s7) var(--s5) var(--s8); }

  .masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: var(--s5); padding-bottom: var(--s6); border-bottom: 1px solid var(--rule);
  }
  h1 { margin: 0 0 var(--s3); font-size: var(--fs-display); font-weight: 600; line-height: 1.1; letter-spacing: -.02em; }
  .lede { margin: 0; max-width: 54ch; color: var(--ink-2); }
  .stamp { margin: 0; flex: none; text-align: right; white-space: nowrap; color: var(--ink-3); font: var(--fs-xs)/1.6 var(--font-mono); }

  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 272px; gap: var(--s7); padding-top: var(--s7); }
  .col { min-width: 0; }

  .run { margin: 0 0 var(--s7); }
  .run:last-child { margin-bottom: 0; }
  .run h2 { margin: 0 0 var(--s2); font-size: var(--fs-xs); font-weight: 500; color: var(--ink-3); }
  .verdict { margin: 0 0 var(--s4); font-size: var(--fs-xl); font-weight: 600; line-height: 1.15; letter-spacing: -.015em; }
  .run--ok .verdict { color: var(--success); }
  .run--bad .verdict { color: var(--danger); }
  .run--idle .verdict { color: var(--ink-3); }
  .run-title { margin: 0 0 var(--s2); font-size: var(--fs-md); font-weight: 500; line-height: 1.4; }
  .run-title a { text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 3px; }
  .run-title a:hover { text-decoration-color: currentColor; }
  .diff { margin-left: var(--s3); color: var(--ink-3); font: var(--fs-xs) var(--font-mono); white-space: nowrap; }
  .note { margin: 0; max-width: 60ch; color: var(--ink-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .run-links { display: flex; gap: var(--s4); margin: var(--s3) 0 0; color: var(--ink-2); font-size: var(--fs-xs); }
  .run-links a { text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 3px; padding: 2px 0; }
  .run-links a:hover { color: var(--ink); text-decoration-color: currentColor; }

  details { margin-top: var(--s4); }
  summary { cursor: pointer; color: var(--ink-2); font-size: var(--fs-xs); }
  summary:hover { color: var(--ink); }
  pre {
    margin: var(--s3) 0 0; padding: var(--s4); overflow: auto;
    background: var(--paper-2); border: 1px solid var(--rule-soft); border-radius: var(--r-md);
    font: var(--fs-xs)/1.65 var(--font-mono); color: var(--ink);
  }

  .log-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s4); margin-bottom: var(--s3); }
  .log-head h2 { margin: 0; font-size: var(--fs-xs); font-weight: 500; color: var(--ink-3); }
  .log-head p { margin: 0; color: var(--ink-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li {
    display: grid; grid-template-columns: 58px minmax(0, 1fr) 76px 104px;
    align-items: baseline; gap: var(--s4); padding: var(--s3) 0; border-top: 1px solid var(--rule-soft);
  }
  .rows li:first-child { border-top-color: var(--rule); }
  .rows time { color: var(--ink-3); font: var(--fs-xs) var(--font-mono); font-variant-numeric: tabular-nums; }
  .h-title { font-size: var(--fs-sm); text-decoration: none; overflow-wrap: anywhere; }
  .h-title:hover { text-decoration: underline; text-underline-offset: 3px; }
  .h-diff { color: var(--ink-3); font: var(--fs-xs) var(--font-mono); }
  .h-result { font-size: var(--fs-xs); text-align: right; }
  .is-ok { color: var(--success); }
  .is-bad { color: var(--danger); }
  .log { margin-top: var(--s7); }
  .empty { padding: var(--s5) 0 var(--s2); }
  .empty h3 { margin: 0 0 var(--s1); font-size: var(--fs-base); font-weight: 500; }

  .rail { display: flex; flex-direction: column; gap: var(--s6); min-width: 0; }
  .panel h2 { margin: 0 0 var(--s2); font-size: var(--fs-xs); font-weight: 500; color: var(--ink-3); }
  .hint { margin: 0 0 var(--s4); color: var(--ink-2); font-size: var(--fs-xs); }
  .hint code { font-family: var(--font-mono); font-size: 12px; }
  .field { display: block; margin: 0 0 var(--s3); }
  .field span { display: block; margin-bottom: var(--s2); color: var(--ink-3); font-size: var(--fs-xs); }
  .field input {
    width: 100%; height: 46px; padding: 0 var(--s3);
    background: var(--paper-2); border: 0; border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--rule); color: var(--ink); font: var(--fs-xs) var(--font-mono);
  }
  .field input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn {
    display: block; width: 100%; height: 48px; margin: 0 0 var(--s2);
    background: transparent; border: 0; border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--rule); color: var(--ink);
    font: 500 var(--fs-base)/1 var(--font-sans); cursor: pointer;
    transition: background var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
  }
  .btn:hover { box-shadow: inset 0 0 0 1px var(--ink-3); }
  .btn--primary { background: var(--accent); color: var(--on-accent); box-shadow: none; }
  .btn--primary:hover { background: var(--accent-hover); box-shadow: none; }
  .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn[disabled] { opacity: .6; cursor: default; }
  .msg { min-height: 1.5em; margin: var(--s2) 0 0; color: var(--ink-2); font-size: var(--fs-xs); }
  .msg.is-ok { color: var(--success); }
  .msg.is-bad { color: var(--danger); }

  .ledger { margin: 0; border-top: 1px solid var(--rule); }
  .ledger div { display: flex; justify-content: space-between; align-items: baseline; padding: var(--s3) 0; border-bottom: 1px solid var(--rule-soft); }
  .ledger dt { color: var(--ink-2); font-size: var(--fs-xs); }
  .ledger dd { margin: 0; font: var(--fs-sm) var(--font-mono); font-variant-numeric: tabular-nums; }

  footer { margin-top: var(--s8); padding-top: var(--s4); border-top: 1px solid var(--rule-soft); color: var(--ink-3); font-size: var(--fs-xs); }

  @media (prefers-reduced-motion: no-preference) {
    .run { animation: enter var(--base) var(--ease) both; }
    .run:nth-of-type(2) { animation-delay: 70ms; }
  }
  @keyframes enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  @media (max-width: 820px) {
    .shell { padding: var(--s6) var(--s5) var(--s7); }
    .masthead { display: block; }
    .stamp { margin-top: var(--s3); text-align: left; }
    .grid { grid-template-columns: 1fr; gap: var(--s6); }
    .run { margin-bottom: var(--s6); }
  }
  @media (max-width: 640px) {
    .rows li { grid-template-columns: minmax(0, 1fr) auto; gap: var(--s1) var(--s4); }
    .rows time { grid-area: 1 / 1; }
    .h-result { grid-area: 1 / 2; }
    .h-title { grid-area: 2 / 1; }
    .h-diff { grid-area: 2 / 2; text-align: right; }
  }
</style>
</head><body>
<div class="shell">
  <header class="masthead">
    <div>
      <h1>One A Day</h1>
      <p class="lede">One unsolved problem every morning at 9:00 IST, solved by a model and submitted to my account. Nothing repeats, through 31 Dec 2026.</p>
    </div>
    <p class="stamp">${esc(fullDate(date))}</p>
  </header>

  <div class="grid">
    <div class="col">
      ${
        seasonOver
          ? `<article class="run run--idle"><h2>Season</h2><p class="verdict">Closed</p><p class="note">The last scheduled run was 31 Dec 2026. Nothing is queued.</p></article>`
          : runBlock(today, "Today's problem", "run-today") + runBlock(featured, "Daily challenge", "run-daily")
      }
    </div>

    <aside class="rail">
      <section class="panel" aria-labelledby="manual-h">
        <h2 id="manual-h">Run by hand</h2>
        <p class="hint">Use these when a scheduled run fails. The key is your <code>TRIGGER_SECRET</code>, kept in this browser.</p>
        <label class="field">
          <span>Trigger key</span>
          <input id="key" type="password" autocomplete="off" spellcheck="false">
        </label>
        <button type="button" class="btn btn--primary" data-track="random">${
          today ? "Retry today&#39;s problem" : "Run today&#39;s problem"
        }</button>
        <button type="button" class="btn" data-track="featured">${
          featured ? "Retry the daily challenge" : "Run the daily challenge"
        }</button>
        <p id="msg" class="msg" role="status" aria-live="polite"></p>
        <noscript><p class="hint">These buttons need JavaScript.</p></noscript>
      </section>

      <section class="panel" aria-labelledby="season-h">
        <h2 id="season-h">Season</h2>
        <dl class="ledger">
          <div><dt>Solved</dt><dd>${acceptedCount}</dd></div>
          <div><dt>Streak</dt><dd>${streak} ${streak === 1 ? "day" : "days"}</dd></div>
          <div><dt>Days left</dt><dd>${daysLeft}</dd></div>
        </dl>
      </section>
    </aside>
  </div>

  <section class="log" aria-labelledby="log-h">
    <div class="log-head">
      <h2 id="log-h">History</h2>
      <p>${history.length ? `${acceptedCount} of ${history.length} accepted` : ""}</p>
    </div>
    ${
      rows
        ? `<ol class="rows">${rows}</ol>`
        : `<div class="empty">
            <h3>No runs yet</h3>
            <p class="note">The first scheduled run starts at 9:00 IST, or start one now.</p>
          </div>`
    }
  </section>

  <footer>Runs on a Cloudflare Worker; state lives in KV.</footer>
</div>
<script>
  var keyEl = document.getElementById("key");
  var msgEl = document.getElementById("msg");
  var buttons = Array.prototype.slice.call(document.querySelectorAll("button[data-track]"));
  var labels = buttons.map(function (b) { return b.textContent; });

  keyEl.value = localStorage.getItem("oneaday.key") || "";

  // One-click setup link (/#key=<secret>) — stores the key, then clears the URL
  // so it does not sit in the address bar or a screenshot.
  var hash = location.hash || "";
  var at = hash.indexOf("key=");
  if (at > -1) {
    var fromHash = decodeURIComponent(hash.slice(at + 4));
    if (fromHash) { localStorage.setItem("oneaday.key", fromHash); keyEl.value = fromHash; }
    history.replaceState(null, "", location.pathname);
  }

  function say(text, kind) {
    msgEl.textContent = text;
    msgEl.className = "msg" + (kind ? " is-" + kind : "");
  }

  function setBusy(on, active) {
    buttons.forEach(function (b, i) {
      b.disabled = on;
      b.textContent = on && i === active ? "Working..." : labels[i];
    });
  }

  function fire(track, active) {
    var secret = keyEl.value.trim();
    if (!secret) { say("Paste the trigger key first.", "bad"); keyEl.focus(); return; }
    localStorage.setItem("oneaday.key", secret);

    setBusy(true, active);
    say("Picking, writing and submitting.");
    fetch("/manual", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trigger-secret": secret },
      body: JSON.stringify({ track: track }),
    })
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
      })
      .then(function (res) {
        setBusy(false);
        var j = res.body || {};
        if (!res.ok) {
          say(j.error === "forbidden" ? "That key was rejected." : (j.error || "The worker refused the request."), "bad");
          return;
        }
        if (j.busy) { say("Already running. Try again once it finishes."); return; }
        if (j.phase === "done") {
          say(j.accepted ? "Accepted. Reloading." : "Not accepted. Reloading.", j.accepted ? "ok" : "bad");
          setTimeout(function () { location.reload(); }, 3000);
          return;
        }
        say("Submitted. The verdict lands within a minute.", "ok");
        setTimeout(function () { location.reload(); }, 70000);
      })
      .catch(function () {
        setBusy(false);
        say("No response from the worker.", "bad");
      });
  }

  buttons.forEach(function (b, i) {
    b.addEventListener("click", function () { fire(b.getAttribute("data-track"), i); });
  });
</script>
</body></html>`;
}

/* ---------------- handlers ---------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async scheduled(event, env, ctx) {
    // every minute: one small step; never let an exception kill the tick
    try {
      await tick(env, false);
    } catch (e) {
      console.error("[tick] failed:", String(e).slice(0, 300));
      // if a step blew up, mark the run so the next tick force-finishes it
      try {
        const s = await env.STATE.get("run:state", "json");
        if (s && !s.error) {
          s.error = `step error in ${s.phase}: ${String(e).slice(0, 200)}`;
          s.phase = s.phase === "record" ? "record" : "record";
          await env.STATE.put("run:state", JSON.stringify(s));
        }
      } catch {
        /* nothing more we can do this tick */
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      const secret = url.searchParams.get("secret") || request.headers.get("x-trigger-secret");
      if (!env.TRIGGER_SECRET || secret !== env.TRIGGER_SECRET) return json({ error: "forbidden" }, 403);
      const force = url.searchParams.get("force") === "1";
      // queue the run; the next cron tick executes steps (free-plan safe)
      const res = await tick(env, force).catch((e) => ({ error: String(e).slice(0, 200) }));
      return json(res);
    }

    if (url.pathname === "/manual") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      const secret = request.headers.get("x-trigger-secret") || url.searchParams.get("secret");
      if (!env.TRIGGER_SECRET || secret !== env.TRIGGER_SECRET) return json({ error: "forbidden" }, 403);
      let body = {};
      try {
        body = await request.json();
      } catch {
        /* empty body -> headline track */
      }
      const track = body?.track === "featured" ? "featured" : "random";
      try {
        return json(await startManual(env, track));
      } catch (e) {
        return json({ error: String(e).slice(0, 300) }, 500);
      }
    }

    if (url.pathname === "/api/pending") {
      // Browser runner asks: is there a submission parked for me?
      // `?probe=1` answers yes/no only, so a cheap pre-check never moves creds.
      const secret = url.searchParams.get("secret") || request.headers.get("x-runner-secret");
      const expected = env.RUNNER_SECRET || env.TRIGGER_SECRET;
      if (!expected || secret !== expected) return json({ error: "forbidden" }, 403);
      const s = await env.STATE.get("run:state", "json");
      const pending = !!s && s.phase === "await_browser";
      if (url.searchParams.get("probe") === "1") return json({ pending, date: s?.date || null });
      if (!pending) return json({ pending: false, date: s?.date || null });
      s.awaitUntil = Date.now() + AWAIT_BROWSER_MS; // a live runner extends the lease
      await saveRun(env, s);
      return json({
        pending: true,
        date: s.date,
        track: s.track || "random",
        slug: s.slug,
        questionId: s.qid,
        attempt: s.attempt,
        code: s.code,
        session: env.LEETCODE_SESSION,
        csrf: env.CSRFTOKEN,
      });
    }

    if (url.pathname === "/api/verdict") {
      // Browser runner reports the judge's answer (it is the only client that
      // can reach both the submit and the check endpoint past the challenge).
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      const secret = request.headers.get("x-runner-secret") || url.searchParams.get("secret");
      const expected = env.RUNNER_SECRET || env.TRIGGER_SECRET;
      if (!expected || secret !== expected) return json({ error: "forbidden" }, 403);
      const body = await request.json().catch(() => ({}));
      const s = await env.STATE.get("run:state", "json");
      if (!s || s.phase !== "await_browser") {
        return json({ error: "no parked run", phase: s?.phase ?? null }, 409);
      }
      if (body.error) {
        s.logs.push({ attempt: s.attempt, status: "browser_error", error: String(body.error).slice(0, 240) });
        s.error = String(body.error).slice(0, 240);
        s.noCooldown = true;
        s.phase = "record";
        await saveRun(env, s);
        await finishRun(env, s, {});
        return json({ accepted: false, recorded: true, error: s.error });
      }
      if (body.sid) s.sid = body.sid;
      await applyVerdict(env, s, {
        status_msg: body.status_msg,
        runtime_display: body.runtime_display,
        total_correct: body.total_correct,
        total_testcases: body.total_testcases,
        compile_error: body.compile_error,
        runtime_error: body.runtime_error,
        last_testcase: body.last_testcase,
        expected_output: body.expected_output,
        code_output: body.code_output,
      });
      if (s.phase === "record") await finishRun(env, s, {});
      return json({
        accepted: !!s.accepted,
        status: s.logs.length ? s.logs[s.logs.length - 1].status : null,
        next: s.phase,
        attempt: s.attempt,
      });
    }

    if (url.pathname === "/api/state") {
      const date = istDate();
      try {
        const [today, featured, history, solved, problems, run] = await Promise.all([
          env.STATE.get(`today:${date}`, "json"),
          env.STATE.get(`featured:${date}`, "json"),
          env.STATE.get("history:list", "json"),
          env.STATE.get("solved:list", "json"),
          env.STATE.get("problems:list", "json"),
          env.STATE.get("run:state", "json"),
        ]);
        return json({
          date,
          endDate: END_DATE,
          today,
          featured,
          history: history || [],
          accountSolved: (solved || []).length,
          poolSize: problems?.problems?.length ?? null,
          run: run ? { phase: run.phase, slug: run.slug, attempt: run.attempt, track: run.track || "random" } : null,
        });
      } catch (e) {
        return json({ error: String(e).slice(0, 200) }, 500);
      }
    }

    // dashboard
    try {
      const date = istDate();
      const [today, featured, history] = await Promise.all([
        env.STATE.get(`today:${date}`, "json"),
        env.STATE.get(`featured:${date}`, "json"),
        env.STATE.get("history:list", "json"),
      ]);
      const html = renderDashboard({
        today,
        featured,
        history: history || [],
      });
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store", // always show the latest run, never a stale copy
        },
      });
    } catch (e) {
      return new Response("dashboard error: " + String(e), { status: 500 });
    }
  },
};
