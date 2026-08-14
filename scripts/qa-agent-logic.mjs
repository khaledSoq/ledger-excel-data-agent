import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:8080/";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^sample$/i }).click();
await page.waitForTimeout(500);

async function ask(prompt) {
  await page.getByPlaceholder(/describe the rows/i).fill(prompt);
  await page.getByRole("button", { name: /send/i }).click();
  await page.waitForTimeout(700);
  return page.locator("body").innerText();
}

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

const afterFilter = await ask("Age between 25 and 40 and Department is Sales");
assert(/Matched \d+/.test(afterFilter), "filter should report Matched N");
assert(!/couldn't turn that into a filter/i.test(afterFilter), "filter should apply");

const afterWhy = await ask("why is the distribution of Salary like this?");
assert(!/couldn't turn that into a filter/i.test(afterWhy), "why-question must not become a filter error");
assert(/Salary|skew|median|mean|family/i.test(afterWhy), "why should narrate the salary shape");
assert(/Matched \d+/.test(afterWhy) || /\d+\s*\/\s*\d+/.test(afterWhy), "filter badge/plan should survive the why follow-up");

const afterSummary = await ask("summarize the filtered results");
assert(/Working set|filtered/i.test(afterSummary), "summary should talk about the working set");
assert(!/couldn't turn that into a filter/i.test(afterSummary), "summary must not be a filter error");

const afterDist = await ask("distribution of Salary");
assert(/Distribution|Normal|Lognormal|Gamma|Poisson|Uniform|Exponential/i.test(afterDist), "distribution should name a family");
assert(!/couldn't turn that into a filter/i.test(afterDist), "distribution must not be a filter error");

await page.screenshot({ path: "/workspace/screenshots/ledger-agent-followup.png" });

await browser.close();
const ok = failures.length === 0 && errors.length === 0;
console.log(JSON.stringify({ ok, failures, errors }, null, 2));
if (!ok) process.exit(1);
