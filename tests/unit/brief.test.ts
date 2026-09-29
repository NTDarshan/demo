import { describe, expect, it } from "vitest";
import { reviewBrief, rulesBrief } from "@/lib/ai/brief/brief";
import { computeSignals, signalsFingerprint, type BriefInput } from "@/lib/ai/brief/signals";

const base = (): BriefInput => ({
  today: "2026-09-29",
  now: "2026-09-29T10:00:00+05:30",
  students: [
    { id: "s1", name: "Sneha Iyer", rollNo: "BCA26-002", balancePaise: 17_300_000, overduePaise: 8_400_000, oldestOverdueDate: "2026-08-15" },
    { id: "s2", name: "Karthik Reddy", rollNo: "BCOM25-002", balancePaise: -250_000, overduePaise: 0, oldestOverdueDate: null },
    { id: "s3", name: "Rohan Kulkarni", rollNo: "CSE24-001", balancePaise: 14_250_000, overduePaise: 2_650_000, oldestOverdueDate: "2026-09-25" },
  ],
  installments: [
    { studentId: "s3", label: "Exam Term 1", dueDate: "2026-09-25", remainingPaise: 2_650_000 },
    { studentId: "s1", label: "Library Term 2", dueDate: "2026-10-03", remainingPaise: 100_000 },
  ],
  payments: [
    { id: "p1", studentId: "s1", amountPaise: 8_650_000, mode: "UPI", status: "PENDING", createdAt: "2026-09-21T19:48:00+05:30", paidAt: null, reversedAt: null, reason: null },
    { id: "p2", studentId: "s3", amountPaise: 500_000, mode: "CASH", status: "SUCCESS", createdAt: "2026-09-28T10:00:00+05:30", paidAt: "2026-09-28T10:00:00+05:30", reversedAt: null, reason: null },
    { id: "p3", studentId: "s3", amountPaise: 2_000_000, mode: "UPI", status: "SUCCESS", createdAt: "2026-09-18T10:00:00+05:30", paidAt: "2026-09-18T10:00:00+05:30", reversedAt: null, reason: null },
    { id: "p4", studentId: "s1", amountPaise: 300_000, mode: "CARD", status: "FAILED", createdAt: "2026-09-27T10:00:00+05:30", paidAt: null, reversedAt: null, reason: "Card declined" },
  ],
  reconItems: [
    { runId: "r2", bucket: "AMOUNT_MISMATCH", gatewayRef: "MGW7300000023", filePaise: 6_200_000, systemPaise: 6_250_000, createdAt: "2026-09-27T10:00:00+05:30", hasSuggestion: true },
    { runId: "r1", bucket: "AMOUNT_MISMATCH", gatewayRef: "MGW7300000023", filePaise: 6_200_000, systemPaise: 6_250_000, createdAt: "2026-09-24T10:00:00+05:30", hasSuggestion: false },
  ],
});

describe("computeSignals", () => {
  const signals = computeSignals(base());
  const get = (id: string) => signals.find((s) => s.id === id);

  it("finds each kind of signal from the ledger", () => {
    expect(signals.map((s) => s.id).sort()).toEqual(["advances", "collections_drop", "due_soon", "failures", "long_overdue", "newly_overdue", "pending_stuck", "recon_open"].sort());
  });
  it("puts a payment stuck for a week above routine reminders", () => {
    expect(signals[0]!.id).toBe("pending_stuck");
    expect(get("pending_stuck")!.severity).toBeGreaterThan(get("due_soon")!.severity);
    expect(get("advances")!.severity).toBeLessThan(20);
  });
  it("counts an exception once when the same file was reconciled twice, and links the newest run", () => {
    const r = get("recon_open")!;
    expect(r.facts.open).toBe(1);
    expect(r.facts.settledShortBy).toBe("₹500");
    expect(r.facts.copilotSuggestionsReady).toBe(1);
    expect(r.actions[0]!.href).toBe("/reconciliation/r2");
  });
  it("compares collections with the previous 7 days", () => {
    expect(get("collections_drop")!.facts).toMatchObject({ last7Days: "₹5,000", previous7Days: "₹20,000", changePercent: "−75%" });
  });
  it("only calls a payment stuck after a day", () => {
    const fresh = { ...base(), now: "2026-09-22T08:00:00+05:30", today: "2026-09-22" };
    expect(computeSignals(fresh).some((s) => s.id === "pending_stuck")).toBe(false);
  });
  it("changes its fingerprint when the numbers change", () => {
    const changed = base();
    changed.payments[0]!.status = "SUCCESS";
    changed.payments[0]!.paidAt = "2026-09-29T09:00:00+05:30";
    expect(signalsFingerprint(computeSignals(changed))).not.toBe(signalsFingerprint(signals));
    expect(signalsFingerprint(computeSignals(base()))).toBe(signalsFingerprint(signals));
  });
});

describe("reviewBrief", () => {
  const signals = computeSignals(base());
  const good = {
    headline: "Confirm the ₹86,500 UPI payment stuck since 21 Sep, then clear the ₹500 shortfall.",
    items: [
      { signalId: "pending_stuck" as const, why: "₹86,500 has been pending for over a week.", actionId: "check_pending" },
      { signalId: "recon_open" as const, why: "The gateway settled ₹500 short.", actionId: "review_exceptions" },
      { signalId: "long_overdue" as const, why: "Sneha Iyer owes ₹84,000.", actionId: "call_list" },
    ],
  };
  it("passes picks, actions and figures that come from the signals", () => {
    expect(reviewBrief(good, signals).every((c) => c.ok)).toBe(true);
  });
  it("rejects an unknown signal, a duplicate, an invented action or too few picks", () => {
    const bad = { ...good, items: [good.items[0]!, good.items[0]!, { signalId: "vip_alert" as never, why: "x", actionId: "call_list" }] };
    expect(reviewBrief(bad, signals)[0]!.ok).toBe(false);
    const action = { ...good, items: [{ ...good.items[0]!, actionId: "waive_fees" }, good.items[1]!, good.items[2]!] };
    expect(reviewBrief(action, signals)[1]!.ok).toBe(false);
    expect(reviewBrief({ ...good, items: good.items.slice(0, 2) }, signals)[0]!.ok).toBe(false);
  });
  it("rejects a made-up figure, and a figure borrowed from another signal", () => {
    expect(reviewBrief({ ...good, headline: "₹9,99,999 is at risk." }, signals)[2]!.ok).toBe(false);
    const borrowed = { ...good, items: [{ ...good.items[0]!, why: "Also the gateway settled ₹500 short." }, good.items[1]!, good.items[2]!] };
    expect(reviewBrief(borrowed, signals)[2]!.detail).toMatch(/another signal/);
  });
});

describe("rulesBrief (no AI)", () => {
  it("picks the three most severe signals with their first action", () => {
    const signals = computeSignals(base());
    const r = rulesBrief(signals, "2026-09-29");
    expect(r.items.map((i) => i.signalId)).toEqual(signals.slice(0, 3).map((s) => s.id));
    expect(reviewBrief(r, signals).every((c) => c.ok)).toBe(true);
  });
  it("says so on a quiet day", () => {
    expect(rulesBrief([], "2026-09-29")).toMatchObject({ items: [], headline: "Nothing urgent in the ledger on 29 Sep 2026." });
  });
});
