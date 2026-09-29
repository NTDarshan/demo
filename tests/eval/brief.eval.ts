// Evaluation of the daily brief against the real model.
//
//   npm run eval:ai
//
// Three days with known priorities: today's demo ledger, a busy synthetic day (parents'
// payments stuck for a week and a ₹1,500 settlement shortfall must lead, not the advance), and
// a quiet day (only an advance: the brief must not invent urgency). Every brief must be written
// by the model (not the rules fallback) and pass its checks.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BriefInput } from "@/lib/ai/brief/signals";

const root = join(__dirname, "../..");
if (existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));
const ready = Boolean(process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

const busy: BriefInput = {
  today: "2026-09-29",
  now: "2026-09-29T10:00:00+05:30",
  students: [
    { id: "a", name: "Asha Rao", rollNo: "BCA25-010", balancePaise: 4_000_000, overduePaise: 0, oldestOverdueDate: null },
    { id: "b", name: "Bharat Shetty", rollNo: "CSE24-020", balancePaise: 6_000_000, overduePaise: 0, oldestOverdueDate: null },
    { id: "c", name: "Chitra Menon", rollNo: "BCOM26-030", balancePaise: -500_000, overduePaise: 0, oldestOverdueDate: null },
  ],
  installments: [{ studentId: "a", label: "Tuition Term 2", dueDate: "2026-10-02", remainingPaise: 4_000_000 }],
  payments: [
    { id: "p1", studentId: "a", amountPaise: 4_000_000, mode: "UPI", status: "PENDING", createdAt: "2026-09-21T10:00:00+05:30", paidAt: null, reversedAt: null, reason: null },
    { id: "p2", studentId: "b", amountPaise: 6_000_000, mode: "CARD", status: "PENDING", createdAt: "2026-09-22T10:00:00+05:30", paidAt: null, reversedAt: null, reason: null },
  ],
  reconItems: [{ runId: "r", bucket: "AMOUNT_MISMATCH", gatewayRef: "MGW7300000099", filePaise: 5_850_000, systemPaise: 6_000_000, createdAt: "2026-09-25T10:00:00+05:30", hasSuggestion: false }],
};

const quiet: BriefInput = {
  today: "2026-09-29",
  now: "2026-09-29T10:00:00+05:30",
  students: [{ id: "c", name: "Chitra Menon", rollNo: "BCOM26-030", balancePaise: -500_000, overduePaise: 0, oldestOverdueDate: null }],
  installments: [],
  payments: [],
  reconItems: [],
};

describe.runIf(ready)("Daily brief eval", () => {
  it("writes a checked brief for today's demo ledger, led by the most severe signal", async () => {
    const [{ writeBrief }, { loadBriefInput }] = await Promise.all([import("@/lib/ai/brief/brief"), import("@/lib/data/brief")]);
    const b = await writeBrief(await loadBriefInput());
    console.log("demo:", b.headline, "|", b.items.map((i) => i.signalId).join(", "));
    expect(b.generatedBy).toBe("ai");
    expect(b.checks.every((c) => c.ok)).toBe(true);
    expect(b.signals.slice(0, 3).map((s) => s.id)).toContain(b.items[0]!.signalId);
  }, 90_000);

  it("on a busy day, stuck payments and the shortfall come before routine items", async () => {
    const { writeBrief } = await import("@/lib/ai/brief/brief");
    const b = await writeBrief(busy);
    console.log("busy:", b.headline, "|", b.items.map((i) => `${i.signalId}: ${i.why}`).join(" / "));
    expect(b.generatedBy).toBe("ai");
    expect(b.checks.every((c) => c.ok)).toBe(true);
    expect(["pending_stuck", "recon_open"]).toContain(b.items[0]!.signalId);
    expect(b.items.map((i) => i.signalId)).not.toContain("advances");
  }, 90_000);

  it("on a quiet day, it does not invent urgency", async () => {
    const { writeBrief } = await import("@/lib/ai/brief/brief");
    const b = await writeBrief(quiet);
    console.log("quiet:", b.headline, "|", b.items.map((i) => `${i.signalId}: ${i.why}`).join(" / "));
    expect(b.checks.every((c) => c.ok)).toBe(true);
    expect(b.items.length).toBeLessThanOrEqual(1);
    expect(b.headline).not.toMatch(/urgent|immediately|risk/i);
  }, 90_000);
});
