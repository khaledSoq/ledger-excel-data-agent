import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:8080/";

const cases = [
  {
    prompt: "All Inactive or On Leave employees from Finance or HR",
    status: ["Inactive", "On Leave"],
    dept: ["Finance", "HR"],
    forbidStatus: ["Active"],
  },
  {
    prompt: "Active or On Leave people in Sales or Marketing",
    status: ["Active", "On Leave"],
    dept: ["Sales", "Marketing"],
  },
  {
    prompt: "Employees who are Inactive from Engineering",
    status: ["Inactive"],
    dept: ["Engineering"],
  },
];

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

function colIndex(headers, name) {
  const target = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === target);
}

for (const c of cases) {
  const matchedBefore = await page.getByText(/Matched \d+/).count();
  await page.getByPlaceholder(/describe the rows/i).fill(c.prompt);
  await page.getByRole("button", { name: /send/i }).click();
  await page.waitForFunction(
    (n) => document.body.innerText.match(/Matched \d+/g)?.length > n,
    matchedBefore,
    { timeout: 8000 },
  );
  await page.waitForTimeout(200);

  const body = await page.locator("body").innerText();
  if (!/Matched \d+/.test(body)) {
    throw new Error(`No match summary for: ${c.prompt}\n${body.slice(0, 800)}`);
  }
  if (/Status eq Inactive OR Department/i.test(body) || /Inactive OR Finance OR HR/i.test(body)) {
    throw new Error(`Flattened OR language for: ${c.prompt}\n${body.slice(0, 800)}`);
  }

  const tableCount = await page.locator("table").count();
  if (!tableCount) {
    if (/Matched 0/.test(body) || /empty/i.test(body)) continue;
    throw new Error(`No table for: ${c.prompt}\n${body.slice(-600)}`);
  }
  await page.locator("table thead th").first().waitFor({ timeout: 3000 });

  const headers = (await page.locator("table thead th").allInnerTexts()).map((h) => h.trim());
  const si = colIndex(headers, "Status");
  const di = colIndex(headers, "Department");
  if (si < 0 || di < 0) throw new Error(`Missing columns: ${headers}`);

  const rows = await page.locator("table tbody tr").all();
  if (!rows.length) {
    // Empty can be valid (e.g. no Inactive Engineering). Still OK if plan is correct.
    if (!/Matched 0 /.test(body) && !/empty/i.test(body)) {
      throw new Error(`No table rows and no empty summary for: ${c.prompt}`);
    }
    continue;
  }
  for (const row of rows) {
    const cells = await row.locator("td").allTextContents();
    const status = cells[si]?.trim();
    const dept = cells[di]?.trim();
    if (!c.status.includes(status)) {
      throw new Error(`${c.prompt}: unexpected Status "${status}"`);
    }
    if (!c.dept.includes(dept)) {
      throw new Error(`${c.prompt}: unexpected Department "${dept}"`);
    }
    if (c.forbidStatus?.includes(status)) {
      throw new Error(`${c.prompt}: forbidden Status "${status}" leaked in`);
    }
  }
}

await page.screenshot({ path: "/workspace/screenshots/ledger-nl-grouping.png" });
await browser.close();
console.log(JSON.stringify({ ok: true, errors, cases: cases.length }, null, 2));
if (errors.length) process.exit(1);
