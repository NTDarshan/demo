// Renders docs/src/documentation.html to docs/Kosha_Documentation.pdf with Chromium.
// Waits for web fonts and for every Mermaid diagram to finish rendering before printing.
//
//   node scripts/build-pdf.ts

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "docs", "src", "documentation.html");
const target = join(root, "docs", "Kosha_Documentation.pdf");

if (!existsSync(source)) {
  console.error(`Missing ${source}`);
  process.exit(1);
}

const footer = `
  <div style="width:100%; font-family:'IBM Plex Sans', Arial, sans-serif; font-size:8pt; color:#5B6478;
              padding:0 22mm; display:flex; justify-content:space-between;">
    <span>Kosha: Fee Collection &amp; Reconciliation</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  // documentation.html sets window.__diagramsDone after mermaid.run() resolves.
  await page.waitForFunction(() => (window as unknown as { __diagramsDone?: boolean }).__diagramsDone === true, null, { timeout: 60_000 });
  const failed = await page.evaluate(() => document.querySelectorAll("pre.mermaid:not([data-processed])").length);
  if (failed > 0 || errors.length > 0) {
    console.error(`Rendering problems: ${failed} diagram(s) not rendered.`, errors.join("\n"));
    process.exitCode = 1;
  }

  await page.pdf({
    path: target,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate: footer,
    margin: { top: "22mm", bottom: "22mm", left: "22mm", right: "22mm" },
    preferCSSPageSize: false,
  });
  console.log(`Wrote ${target.replace(root, ".")}`);
} finally {
  await browser.close();
}
