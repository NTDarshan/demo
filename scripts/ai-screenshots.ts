// Captures screenshots of the AI features for the PDF documentation (docs/assets/doc/ai-*.png).
// Needs the app running with OPENAI_API_KEY set. Resets the demo data, uploads the sample
// settlement file, then drives each feature once with the real model. Leaves the data in that
// state (Copilot suggestions and today's brief present) for demos.
//
//   node scripts/ai-screenshots.ts          (BASE_URL defaults to http://localhost:3000)

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "assets", "doc");
const base = process.env.BASE_URL ?? "http://localhost:3000";
mkdirSync(out, { recursive: true });

const admin = { cookie: "kosha_role=admin" };
const reset = await fetch(`${base}/api/demo/reset`, { method: "POST", headers: admin });
if (!reset.ok) throw new Error(`reset: ${reset.status}`);
const form = new FormData();
form.append("file", new Blob([readFileSync(join(root, "public/samples/settlement_sample.csv"))], { type: "text/csv" }), "settlement_sample.csv");
const up = await fetch(`${base}/api/reconciliation`, { method: "POST", body: form, headers: admin });
const runId = ((await up.json()) as { data: { id: string } }).data.id;
console.log("run", runId);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1500 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "kosha_role", value: "admin", url: base }]);
  await ctx.addInitScript(() => localStorage.setItem("kosha.demoGuideSeen", "1"));
  const page = await ctx.newPage();
  const dialog = () => page.locator('[role="dialog"]');

  // Daily brief (written on the first dashboard visit of the day).
  await page.goto(`${base}/`);
  await page.waitForSelector("text=/picked and explained by|Written by rules/", { timeout: 90_000 });
  await page.waitForTimeout(500);
  await page.locator("section[aria-label=\"Today's brief\"]").screenshot({ path: join(out, "ai-brief.png") });
  console.log("brief");

  // Reconciliation Copilot: investigate all, then open one suggestion.
  await page.goto(`${base}/reconciliation/${runId}`);
  await page.getByRole("button", { name: /Investigate all/ }).click();
  await page.waitForSelector("text=4 of 4 open exceptions have a suggestion ready", { timeout: 180_000 });
  await page.locator("[role=tab]", { hasText: "Settled but pending" }).click();
  await page.waitForTimeout(400);
  await page.locator("main").screenshot({ path: join(out, "ai-copilot-run.png"), clip: undefined });
  await page.getByTitle("Open the Copilot's suggestion").first().click();
  await page.waitForSelector("text=Suggested action");
  await page.waitForTimeout(600);
  await dialog().screenshot({ path: join(out, "ai-copilot.png") });
  await page.keyboard.press("Escape");
  await page.locator("[role=tab]", { hasText: "Amount mismatch" }).click();
  await page.getByTitle("Open the Copilot's suggestion").first().click();
  await page.waitForSelector("text=Suggested action");
  await page.waitForTimeout(600);
  await dialog().screenshot({ path: join(out, "ai-copilot-mismatch.png") });
  await page.keyboard.press("Escape");
  console.log("copilot");

  // Ask Kosha: a question and a follow-up.
  await page.goto(`${base}/students`);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Ask Kosha/ }).click();
  await page.locator("#ask-input").fill("Which students owe more than ₹1,00,000 and are overdue?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] summary').length >= 1, null, { timeout: 90_000 });
  await page.locator("#ask-input").fill("only the BCA ones");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] summary').length >= 2, null, { timeout: 90_000 });
  await page.waitForTimeout(800);
  await dialog().screenshot({ path: join(out, "ai-ask.png") });
  await page.keyboard.press("Escape");
  console.log("ask");

  // Smart import preview (not reconciled).
  await page.goto(`${base}/reconciliation`);
  await page.waitForTimeout(1500);
  await page.locator("#settlement-file").setInputFiles(join(root, "public/samples/gateway_report_sep_2026.csv"));
  await page.waitForSelector("text=/rows convert cleanly/", { timeout: 90_000 });
  await page.waitForTimeout(500);
  await page.locator("div", { has: page.locator("text=uses a different layout") }).filter({ has: page.locator("text=rows convert cleanly") }).last().screenshot({ path: join(out, "ai-import.png") });
  console.log("import");

  // Message to a parent, in Kannada.
  await page.goto(`${base}/students/BCA26-002`);
  await page.getByRole("button", { name: "Message parent" }).click();
  await page.locator("label", { hasText: "ಕನ್ನಡ" }).click();
  await page.getByRole("button", { name: "Draft message" }).click();
  await page.waitForSelector("text=/Checked against the ledger|Check before sending/", { timeout: 90_000 });
  await page.waitForTimeout(600);
  await dialog().screenshot({ path: join(out, "ai-message.png") });
  console.log("message");
} finally {
  await browser.close();
}
