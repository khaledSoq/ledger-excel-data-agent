import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:8080/";

const browser = await chromium.launch({ headless: true });

async function shot(page, path, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(250);
  await page.screenshot({ path, fullPage: false });
}

const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^sample$/i }).click();
await page.waitForTimeout(400);
const body = await page.locator("body").innerText();
if (!body.includes("employees.xlsx") && !body.includes("Inspected")) {
  throw new Error("Sample did not load: " + body.slice(0, 400));
}

await page.getByPlaceholder(/describe the rows/i).fill(
  "Age between 25 and 40 and Department is Sales",
);
await page.getByRole("button", { name: /send/i }).click();
await page.waitForTimeout(500);
const after = await page.locator("body").innerText();
if (!after.includes("Sales") || !after.includes("Matched")) {
  throw new Error("Filter did not apply: " + after.slice(0, 600));
}

await shot(page, "/workspace/screenshots/ledger-desktop.png", 1280, 800);

await page.getByRole("button", { name: /formulas/i }).click();
await page.waitForTimeout(200);
await shot(page, "/workspace/screenshots/ledger-formulas.png", 1280, 800);

await page.getByRole("button", { name: /inspect/i }).click();
await page.waitForTimeout(200);
await shot(page, "/workspace/screenshots/ledger-inspect.png", 1280, 800);

await shot(page, "/workspace/screenshots/ledger-mobile.png", 390, 844);

const overflow = await page.evaluate(() => {
  return document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
});

await browser.close();
console.log(JSON.stringify({ errors, overflow, ok: errors.length === 0 && !overflow }, null, 2));
if (errors.length || overflow) process.exit(1);
