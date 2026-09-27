// Evaluation of smart import and parent messages against the real model (read-only).
//
//   npm run eval:ai
//
// Smart import: two unfamiliar layouts with a known right mapping. The gateway report has
// decoys (Net vs Gross amount, Txn Date vs Settlement Date, a payout UTR next to the
// transaction reference); the second has amounts in paise, ISO dates and no status column.
// Parent messages: four purpose/language/channel combinations must pass every check
// (ledger figures only, key amount present, right script, no assumed gender, ₹ digits).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { afterAll, describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
if (existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));
const ready = Boolean(process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

const report: { case: string; pass: boolean; detail: string; seconds: number }[] = [];

describe.runIf(ready)("Smart import and parent messages eval", () => {
  afterAll(() => {
    if (!report.length) return;
    console.table(report);
    const passed = report.filter((r) => r.pass).length;
    console.log(`AI-3 eval: ${passed}/${report.length} cases passed.`);
    mkdirSync(join(root, "test-results"), { recursive: true });
    writeFileSync(join(root, "test-results/ai3-eval.json"), JSON.stringify({ at: new Date().toISOString(), passed, total: report.length, cases: report }, null, 2));
  });

  async function mapFile(name: string, headers: string[], rows: Record<string, string>[], expected: Record<string, unknown>) {
    const { proposeMapping } = await import("@/lib/ai/settlement-mapper");
    const { applyMapping, sampleRows } = await import("@/lib/domain/settlement-mapping");
    const r = await proposeMapping(headers, sampleRows(rows));
    const full = applyMapping(rows, r.mapping);
    const got = {
      gatewayRef: r.mapping.gatewayRef.column,
      amount: r.mapping.amount.column,
      unit: r.mapping.amount.unit,
      status: r.mapping.status.column,
      settledAt: r.mapping.settledAt.column,
      format: r.mapping.settledAt.format,
    };
    const pass = Object.entries(expected).every(([k, v]) => got[k as keyof typeof got] === v) && full.issues.length === 0;
    report.push({ case: `import: ${name}`, pass, detail: `${Object.values(got).join(" | ")} · ${full.stats.converted}/${full.stats.rows} rows`, seconds: Math.round(r.latencyMs / 100) / 10 });
    return pass;
  }

  it("maps the gateway's own report layout (gross not net, settlement not txn date, ref not UTR)", async () => {
    const text = readFileSync(join(root, "public/samples/gateway_report_sep_2026.csv"), "utf8");
    const p = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const pass = await mapFile("gateway report", p.meta.fields!, p.data, {
      gatewayRef: "Txn Reference",
      amount: "Gross Amount (Rs)",
      unit: "rupees",
      status: "Txn Status",
      settledAt: "Settlement Date",
      format: "DD/MM/YYYY",
    });
    expect(pass).toBe(true);
  }, 90_000);

  it("maps a layout with paise, ISO dates, decoy ids and no status column", async () => {
    const standard = readFileSync(join(root, "public/samples/settlement_sample.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
    const headers = ["order_id", "pg_txn_id", "utr", "amount_paise", "fee_paise", "settled_on"];
    const rows = standard.map(([ref, amount, , settled], i) => ({
      order_id: `ORD-2026-${String(4100 + i)}`,
      pg_txn_id: ref!,
      utr: `UTIB${String(88213400 + i * 7)}`,
      amount_paise: String(Math.round(Number(amount) * 100)),
      fee_paise: "0",
      settled_on: settled!.slice(0, 10),
    }));
    const pass = await mapFile("paise + ISO, no status", headers, rows, { gatewayRef: "pg_txn_id", amount: "amount_paise", unit: "paise", status: "", settledAt: "settled_on", format: "ISO" });
    expect(pass).toBe(true);
  }, 90_000);

  const messages = [
    { roll: "BCA26-002", purpose: "OVERDUE", language: "kn", channel: "whatsapp" },
    { roll: "CSE24-001", purpose: "BALANCE", language: "hi", channel: "email" },
    { roll: "BCA25-001", purpose: "THANK_YOU", language: "en", channel: "email" },
    { roll: "CSE24-001", purpose: "REMINDER", language: "en", channel: "whatsapp" },
  ] as const;

  for (const m of messages) {
    it(`drafts a ${m.purpose} message in ${m.language} for ${m.channel} (${m.roll})`, async () => {
      const [{ draftParentMessage }, { buildFacts }, students, dates] = await Promise.all([
        import("@/lib/ai/parent-message/draft"),
        import("@/lib/ai/parent-message/facts"),
        import("@/lib/data/students"),
        import("@/lib/dates"),
      ]);
      const detail = await students.getStudentDetail(await students.resolveStudentId(m.roll));
      const { facts, amountsPaise, purposes } = buildFacts(detail, dates.isoDateIST());
      const r = await draftParentMessage({ facts, amountsPaise, purpose: m.purpose, check: purposes[m.purpose], language: m.language, channel: m.channel });
      const failed = r.verification.checks.filter((c) => !c.ok).map((c) => c.detail);
      report.push({
        case: `message: ${m.purpose} ${m.language} ${m.channel}`,
        pass: r.verification.ok,
        detail: failed.join(" ") || `${r.verification.verifiedAmounts.length} amounts checked${r.attempts > 1 ? ", rewritten once" : ""}`,
        seconds: Math.round(r.latencyMs / 100) / 10,
      });
      expect(r.verification.ok).toBe(true);
    }, 90_000);
  }
});
