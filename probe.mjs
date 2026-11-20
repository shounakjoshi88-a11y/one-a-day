// throwaway: does a real Chromium on a GitHub runner get past LeetCode's challenge?
const { chromium } = await import("playwright");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function tryMode(label, opts) {
  const browser = await chromium.launch(opts);
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();
  const statuses = [];
  page.on("response", (r) => {
    if (r.url().includes("/problems/two-sum") && r.request().resourceType() === "document") statuses.push(r.status());
  });
  try {
    await page.goto("https://leetcode.com/problems/two-sum/", { waitUntil: "domcontentloaded", timeout: 60000 });
    for (let i = 0; i < 20; i++) {
      const t = await page.title();
      if (!/just a moment|attention required/i.test(t)) break;
      await page.waitForTimeout(1500);
    }
    const title = await page.title();
    const body = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 160).replace(/\s+/g, " ");
    console.log(`[${label}] docStatuses=${statuses.join(",")} title=${JSON.stringify(title)}`);
    console.log(`[${label}] body: ${body}`);
    const probe = await page.evaluate(async () => {
      const r = await fetch("/problems/two-sum/", { credentials: "include" });
      return { status: r.status, mitigated: r.headers.get("cf-mitigated") };
    });
    console.log(`[${label}] in-page fetch -> ${JSON.stringify(probe)}`);
  } catch (e) {
    console.log(`[${label}] ERROR ${String(e).slice(0, 160)}`);
  }
  await browser.close();
}

const args = ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"];
await tryMode("headless-new", { headless: true, args, channel: undefined });
await tryMode("headed", { headless: false, args });
