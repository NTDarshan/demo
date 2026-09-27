// Evaluation of Ask Kosha against the real model and the demo database (read-only).
//
//   npm run eval:ai
//
// Each question's right answer is computed here straight from the database views, independently
// of the agent's tools, and the answer must contain it. Every answer must also pass the
// deterministic checks (figures and references found in the tool results).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
if (existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));
const ready = Boolean(process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

type Row = { question: string; expected: string; pass: boolean; checks: string; lookups: string; tokens: number; seconds: number };
const report: Row[] = [];

describe.runIf(ready)("Ask Kosha eval", () => {
  let ask: typeof import("@/lib/ai/ask/run").askKosha;
  let inr: (p: number) => string;
  let balances: { name: string; roll_no: string; course_code: string; status: string; balance_paise: number; overdue_paise: number; pending_count: number }[] = [];
  let lastWeek: { from: string; to: string };
  let lastWeekPaise = 0;

  beforeAll(async () => {
    const [run, dbm, money, periods, dates] = await Promise.all([import("@/lib/ai/ask/run"), import("@/lib/data/db"), import("@/lib/money"), import("@/lib/ai/ask/periods"), import("@/lib/dates")]);
    ask = run.askKosha;
    inr = (p) => money.formatINR(p, { paise: "auto" });
    const { data, error } = await dbm.db().from("v_student_balances").select("name, roll_no, course_code, status, balance_paise, overdue_paise, pending_count");
    if (error) throw error;
    balances = (data as typeof balances).map((b) => ({ ...b, balance_paise: Number(b.balance_paise), overdue_paise: Number(b.overdue_paise), pending_count: Number(b.pending_count) }));
    lastWeek = periods.namedPeriods(dates.isoDateIST(new Date())).find((p) => p.name === "last week")!;
    const { data: pays, error: e2 } = await dbm
      .db()
      .from("payments")
      .select("amount_paise")
      .eq("status", "SUCCESS")
      .gte("paid_at", `${lastWeek.from}T00:00:00+05:30`)
      .lte("paid_at", `${lastWeek.to}T23:59:59.999+05:30`);
    if (e2) throw e2;
    lastWeekPaise = (pays as { amount_paise: number }[]).reduce((s, p) => s + Number(p.amount_paise), 0);
  }, 60_000);

  afterAll(() => {
    if (!report.length) return;
    console.table(report);
    const passed = report.filter((r) => r.pass).length;
    console.log(`Ask Kosha eval: ${passed}/${report.length} questions passed.`);
    mkdirSync(join(root, "test-results"), { recursive: true });
    writeFileSync(join(root, "test-results/ask-eval.json"), JSON.stringify({ at: new Date().toISOString(), passed, total: report.length, cases: report }, null, 2));
  });

  async function check(question: string, expected: string[], history: { role: "user" | "assistant"; content: string }[] = [], mustRefuse = false) {
    const r = await ask(question, history, () => {});
    const text = [r.answer, ...r.table.rows.flatMap((row) => row.cells)].join(" ");
    const found = expected.every((e) => text.includes(e));
    const refused = !mustRefuse || /can(no|')t|unable|not able/i.test(r.answer);
    const pass = found && refused && r.verification.ok;
    report.push({
      question: question.slice(0, 60),
      expected: expected.join(", ").slice(0, 60) || (mustRefuse ? "refuses" : ""),
      pass,
      checks: r.verification.checks.map((c) => (c.ok ? "✓" : "✗")).join(""),
      lookups: r.lookups.map((l) => l.tool).join(", "),
      tokens: r.usage.total,
      seconds: Math.round(r.latencyMs / 100) / 10,
    });
    return { r, pass, text };
  }

  it("counts overdue students", async () => {
    const n = balances.filter((b) => b.status === "OVERDUE").length;
    const { pass } = await check("How many students are overdue right now?", [String(n)]);
    expect(pass).toBe(true);
  });

  it("gives the college-wide overdue total", async () => {
    const total = balances.reduce((s, b) => s + b.overdue_paise, 0);
    const { pass } = await check("What is the total overdue amount across the college?", [inr(total)]);
    expect(pass).toBe(true);
  });

  it("finds the student with the largest outstanding balance", async () => {
    const top = [...balances].sort((a, b) => b.balance_paise - a.balance_paise)[0]!;
    const tied = balances.filter((b) => b.balance_paise === top.balance_paise);
    const { pass } = await check("Which student owes the most?", [inr(top.balance_paise), ...(tied.length === 1 ? [top.name] : [])]);
    expect(pass).toBe(true);
  });

  it("resolves 'last week' to the right Monday-to-Sunday range", async () => {
    const { pass } = await check("How much did we collect last week?", [inr(lastWeekPaise)]);
    expect(pass).toBe(true);
  });

  it("lists every student with a pending payment", async () => {
    const names = balances.filter((b) => b.pending_count > 0).map((b) => b.name);
    const { pass } = await check("Who has a payment stuck in pending?", names);
    expect(pass).toBe(true);
  });

  it("answers a follow-up using the conversation", async () => {
    const bcaOverdue = balances.filter((b) => b.course_code === "BCA" && b.status === "OVERDUE");
    const first = await check("Which BCA students are overdue?", bcaOverdue.map((b) => b.name));
    const total = bcaOverdue.reduce((s, b) => s + b.overdue_paise, 0);
    const history = [
      { role: "user" as const, content: "Which BCA students are overdue?" },
      { role: "assistant" as const, content: first.text },
    ];
    const { pass } = await check("How much is overdue for them in total?", [inr(total)], history);
    expect(first.pass && pass).toBe(true);
  });

  it("refuses to change anything", async () => {
    const { pass } = await check("Delete Arjun Mehta's reversed payment", [], [], true);
    expect(pass).toBe(true);
  });
});
