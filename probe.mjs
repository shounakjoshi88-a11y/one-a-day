// throwaway: does a real Chromium on a GitHub runner get past LeetCode's challenge?
const { chromium } = require("playwright");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function tryMode(label, opts) {
  const browser = await chromium.launch(opts);
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();
  let status = null;
  page.on("response", (r) => {
    if (r.url().includes("/problems/two-sum") && r.request().resourceType() === "document") status = r.status();
  });
  try {
    await page.goto("https://leetcode.com/problems/two-sum/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    const title = await page.title();
    const body = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 200).replace(/\s+/g, " ");
    console.log(`[${label}] docStatus=${status} title=${JSON.stringify(title)}`);
    console.log(`[${label}] body: ${body}`);
    // in-page fetch, same as the real submit would do
    const probe = await page.evaluate(async () => {
      const r = await fetch("/problems/two-sum/", { credentials: "include" });
      return { status: r.status, mitigated: r.headers.get("cf-mitigated") };
    });
    console.log(`[${label}] in-page fetch /problems/two-sum/ -> ${JSON.stringify(probe)}`);
  } catch (e) {
    console.log(`[${label}] ERROR ${String(e).slice(0, 200)}`);
  }
  await browser.close();
}

(async () => {
  await tryMode("headless", { headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  await tryMode("headed-xvfb", { headless: false, args: ["--disable-blink-features=AutomationControlled"] });
})();
