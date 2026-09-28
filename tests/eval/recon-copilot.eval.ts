// Evaluation of the Reconciliation Copilot against the real model and the demo database.
//
//   npm run eval:ai
//
// Not part of `npm test`: it calls OpenAI (about 5 investigations, a few cents) and resets the
// demo data before and after. Each case has a known right answer, so this measures whether the
// agent reaches it, not just whether the code runs:
//
//   settled but pending (x2)   -> MARK_PAID, cause GATEWAY_CONFIRMED_LATE
//   amount mismatch (₹500 short)-> never MARK_PAID; cause SETTLEMENT_SHORT; draft message to the gateway
//   missing in settlement      -> never MARK_PAID; ESCALATE or MARK_REVIEWED
//   staged double payment      -> the parent paid again at the counter: the duplicate must be found,
//                                 and the diagnosis must not recommend marking paid without saying so
//
// Every case must also pass the deterministic checks (figures, evidence, allowed action).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
if (existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));

const ready = Boolean(process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);
if (!ready) console.warn("Skipping the Copilot eval: set OPENAI_API_KEY and the Supabase keys in .env.local");

type Row = { case: string; bucket: string; expected: string; got: string; cause: string; confidence: string; checks: string; lookups: number; tokens: number; seconds: number; pass: boolean };
const report: Row[] = [];

describe.runIf(ready)("Reconciliation Copilot eval", () => {
  // Imported lazily so the file loads (and skips) cleanly without keys.
  let lib: {
    rpc: typeof import("@/lib/data/db").rpc;
    db: typeof import("@/lib/data/db").db;
    investigate: typeof import("@/lib/ai/recon-copilot/run").investigateReconItem;
    reconcileCsv: typeof import("@/lib/domain/settlement-csv").reconcileCsv;
    systemPayments: typeof import("@/lib/data/reconciliation").systemPaymentsForRecon;
  };
  let items: { id: string; bucket: string; gateway_ref: string; payment_id: string | null; system_amount_paise: number | null }[] = [];

  beforeAll(async () => {
    const [dbm, runm, csv, recon] = await Promise.all([
      import("@/lib/data/db"),
      import("@/lib/ai/recon-copilot/run"),
      import("@/lib/domain/settlement-csv"),
      import("@/lib/data/reconciliation"),
    ]);
    lib = { rpc: dbm.rpc, db: dbm.db, investigate: runm.investigateReconItem, reconcileCsv: csv.reconcileCsv, systemPayments: recon.systemPaymentsForRecon };

    await lib.rpc("reset_demo", { p_actor: "admin" });
    const text = readFileSync(join(root, "public/samples/settlement_sample.csv"), "utf8");
    const result = lib.reconcileCsv(text, await lib.systemPayments());
    if (!result.ok) throw new Error(result.message);
    const runId = await lib.rpc<string>("create_recon_run", {
      p_file_name: "settlement_sample.csv",
      p_actor: "accountant",
      p_row_count: result.totals.rows,
      p_totals: result.totals,
      p_rejected: result.rejected,
      p_items: result.items.map((i) => ({
        bucket: i.bucket,
        gateway_ref: i.gatewayRef,
        file_amount_paise: i.fileAmountPaise,
        file_status: i.fileStatus,
        settled_at: i.settledAt,
        system_amount_paise: i.systemAmountPaise,
        system_status: i.systemStatus,
        payment_id: i.paymentId,
      })),
    });
    const { data, error } = await lib.db().from("reconciliation_items").select("id, bucket, gateway_ref, payment_id, system_amount_paise").eq("run_id", runId).neq("bucket", "MATCHED").order("gateway_ref");
    if (error) throw error;
    items = data as typeof items;
  }, 180_000);

  afterAll(async () => {
    if (lib) await lib.rpc("reset_demo", { p_actor: "admin" });
    if (report.length) {
      console.table(report);
      const passed = report.filter((r) => r.pass).length;
      console.log(`Copilot eval: ${passed}/${report.length} cases passed.`);
      mkdirSync(join(root, "test-results"), { recursive: true });
      writeFileSync(join(root, "test-results/copilot-eval.json"), JSON.stringify({ at: new Date().toISOString(), model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini", passed, total: report.length, cases: report }, null, 2));
    }
  }, 180_000);

  async function runCase(name: string, itemId: string, bucket: string, expected: string, judge: (inv: Awaited<ReturnType<typeof lib.investigate>>) => boolean) {
    const inv = await lib.investigate(itemId, "accountant", () => {});
    const pass = judge(inv) && inv.verification.ok;
    report.push({
      case: name,
      bucket,
      expected,
      got: inv.recommendation,
      cause: inv.diagnosis.rootCause,
      confidence: inv.confidence,
      checks: inv.verification.checks.map((c) => (c.ok ? "✓" : "✗")).join(""),
      lookups: inv.trace.length,
      tokens: inv.usage.total,
      seconds: Math.round(inv.latencyMs / 100) / 10,
      pass,
    });
    return { inv, pass };
  }

  it("settled but pending: suggests mark as paid", async () => {
    const pending = items.filter((i) => i.bucket === "SETTLED_PENDING_HERE");
    expect(pending).toHaveLength(2);
    // The second one is used for the double-payment case below.
    const { inv, pass } = await runCase(`pending ${pending[0]!.gateway_ref}`, pending[0]!.id, "SETTLED_PENDING_HERE", "MARK_PAID", (i) => i.recommendation === "MARK_PAID");
    expect(pass).toBe(true);
    expect(inv.recommendation).toBe("MARK_PAID");
    expect(inv.diagnosis.rootCause).toBe("GATEWAY_CONFIRMED_LATE");
    expect(inv.verification.ok).toBe(true);
  }, 120_000);

  it("amount mismatch: never marks paid, finds the shortfall and drafts a message to the gateway", async () => {
    const item = items.find((i) => i.bucket === "AMOUNT_MISMATCH")!;
    const { inv, pass } = await runCase(`mismatch ${item.gateway_ref}`, item.id, "AMOUNT_MISMATCH", "ESCALATE / REVIEWED, SETTLEMENT_SHORT", (i) => i.recommendation !== "MARK_PAID" && i.diagnosis.rootCause === "SETTLEMENT_SHORT");
    expect(pass).toBe(true);
    expect(inv.diagnosis.rootCause).toBe("SETTLEMENT_SHORT");
    expect(inv.diagnosis.gatewayQuery).toMatch(/₹500/);
    expect(inv.verification.ok).toBe(true);
  }, 120_000);

  it("missing in settlement: never marks paid and searches the file and other runs", async () => {
    const item = items.find((i) => i.bucket === "MISSING_IN_SETTLEMENT")!;
    const { inv, pass } = await runCase(`missing ${item.gateway_ref}`, item.id, "MISSING_IN_SETTLEMENT", "ESCALATE / REVIEWED", (i) => i.recommendation !== "MARK_PAID");
    expect(pass).toBe(true);
    expect(inv.trace.map((t) => t.tool)).toContain("search_settlement_file");
    expect(inv.verification.ok).toBe(true);
  }, 120_000);

  it("double payment: the parent paid again at the counter, and the Copilot catches it", async () => {
    const item = items.filter((i) => i.bucket === "SETTLED_PENDING_HERE")[1]!;
    const { data: pay } = await lib.db().from("payments").select("student_id").eq("id", item.payment_id!).single();
    // Stage it through the normal money function: a cash payment of the same amount, same student.
    await lib.rpc("record_payment", {
      p_student_id: (pay as { student_id: string }).student_id,
      p_amount_paise: item.system_amount_paise,
      p_mode: "CASH",
      p_idempotency_key: randomUUID(),
      p_simulate: null,
      p_actor: "accountant",
    });
    const { inv, pass } = await runCase(`double payment ${item.gateway_ref}`, item.id, "SETTLED_PENDING_HERE", "POSSIBLE_DUPLICATE, not marked paid", (i) =>
      i.trace.some((t) => t.tool === "check_duplicate_payments") &&
      // Either it names the duplicate as the cause and does not mark paid, or it marks paid and
      // the verifier's "Duplicate risk disclosed" check ran and passed.
      ((i.diagnosis.rootCause === "POSSIBLE_DUPLICATE" && i.recommendation !== "MARK_PAID") ||
        i.verification.checks.some((c) => c.name === "Duplicate risk disclosed" && c.ok)),
    );
    expect(inv.trace.map((t) => t.tool)).toContain("check_duplicate_payments");
    // Matching the words "duplicate" in the text would also accept "no duplicate found", so the
    // judge above looks at the cause, the action and the verifier's own check instead.
    expect(pass).toBe(true);
  }, 120_000);
});
