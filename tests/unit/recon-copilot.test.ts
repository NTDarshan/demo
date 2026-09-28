import { describe, expect, it } from "vitest";
import { editDistance, similarity } from "@/lib/ai/recon-copilot/match";
import { tidyDiagnosis, type Diagnosis } from "@/lib/ai/recon-copilot/schema";
import { allowedActions, downgrade, extractRupeeAmounts, feedbackFor, verifyDiagnosis, type VerifyContext } from "@/lib/ai/recon-copilot/verify";
import { describeAudit } from "@/lib/domain/audit-text";

const diagnosis = (over: Partial<Diagnosis> = {}): Diagnosis => ({
  headline: "The gateway settled ₹86,500 but the payment timed out here.",
  rootCause: "GATEWAY_CONFIRMED_LATE",
  confidence: "high",
  findings: [
    { text: "Gateway says SUCCESS for ₹86,500.", evidence: ["gateway:MGW7300000005"] },
    { text: "No other payment of ₹86,500 within 7 days.", evidence: ["check:duplicates"] },
  ],
  recommendation: { action: "MARK_PAID", reason: "Gateway confirms the full amount.", note: "Gateway confirmed ₹86,500; no duplicate." },
  gatewayQuery: "",
  nextSteps: [],
  risks: [],
  ...over,
});

const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
  bucket: "SETTLED_PENDING_HERE",
  paymentStatusNow: "PENDING",
  knownAmountsPaise: new Set([8_650_000]),
  evidenceIds: new Set(["gateway:MGW7300000005", "check:duplicates", "item:MGW7300000005"]),
  duplicateSuspected: false,
  ...over,
});

describe("allowedActions mirrors resolve_recon_item()", () => {
  it("allows mark as paid only for settled-but-pending items whose payment is pending or already successful", () => {
    expect(allowedActions("SETTLED_PENDING_HERE", "PENDING")).toContain("MARK_PAID");
    expect(allowedActions("SETTLED_PENDING_HERE", "SUCCESS")).toContain("MARK_PAID");
    expect(allowedActions("SETTLED_PENDING_HERE", "FAILED")).not.toContain("MARK_PAID");
    expect(allowedActions("AMOUNT_MISMATCH", "SUCCESS")).toEqual(["MARK_REVIEWED", "ESCALATE"]);
    expect(allowedActions("MISSING_IN_SETTLEMENT", "SUCCESS")).toEqual(["MARK_REVIEWED", "ESCALATE"]);
    expect(allowedActions("MATCHED", "SUCCESS")).toEqual([]);
  });
});

describe("extractRupeeAmounts", () => {
  it("reads ₹, Rs and INR amounts in Indian and international grouping", () => {
    const got = extractRupeeAmounts("Paid ₹1,25,000.50, settled Rs. 62,000 and INR 500; short by ₹ 500.");
    expect(got.map((a) => a.paise)).toEqual([12_500_050, 6_200_000, 50_000, 50_000]);
  });
  it("ignores plain numbers that are not money", () => {
    expect(extractRupeeAmounts("Line 17, 2 days late, roll CSE24-001")).toEqual([]);
  });
});

describe("verifyDiagnosis", () => {
  it("passes a diagnosis whose figures, evidence and action all check out", () => {
    const v = verifyDiagnosis(diagnosis(), ctx());
    expect(v.ok).toBe(true);
    expect(v.verifiedAmountCount).toBe(4);
  });

  it("catches a figure the tools never returned (a hallucinated amount)", () => {
    const v = verifyDiagnosis(diagnosis({ headline: "The gateway settled ₹85,600." }), ctx());
    expect(v.ok).toBe(false);
    expect(v.unverifiedAmounts).toEqual(["₹85,600"]);
  });

  it("catches evidence ids that no tool produced, and findings with no evidence", () => {
    const bad = diagnosis({ findings: [{ text: "Bank confirmed it.", evidence: ["bank:statement"] }, { text: "Looks fine.", evidence: [] }] });
    const v = verifyDiagnosis(bad, ctx());
    expect(v.ok).toBe(false);
    expect(v.unknownEvidence).toEqual(["bank:statement"]);
  });

  it("rejects an action the rules forbid, and downgrade() turns it into a low-confidence escalation", () => {
    const d = diagnosis();
    const v = verifyDiagnosis(d, ctx({ bucket: "AMOUNT_MISMATCH", paymentStatusNow: "SUCCESS" }));
    expect(v.ok).toBe(false);
    expect(feedbackFor(v)).toContain("Action allowed");
    const safe = downgrade(d, v);
    expect(safe.recommendation.action).toBe("ESCALATE");
    expect(safe.confidence).toBe("low");
  });

  it("requires the duplicate risk to be disclosed before suggesting mark as paid", () => {
    expect(verifyDiagnosis(diagnosis(), ctx({ duplicateSuspected: true })).ok).toBe(false);
    const disclosed = diagnosis({ risks: ["The parent paid ₹86,500 again; one of the two must be refunded or kept as advance."] });
    expect(verifyDiagnosis(disclosed, ctx({ duplicateSuspected: true })).ok).toBe(true);
  });

  it("checks the drafted message to the gateway too", () => {
    const v = verifyDiagnosis(diagnosis({ gatewayQuery: "Please explain the ₹900 shortfall." }), ctx());
    expect(v.unverifiedAmounts).toEqual(["₹900"]);
  });

  it("leaves a passing diagnosis unchanged", () => {
    const d = diagnosis();
    expect(downgrade(d, verifyDiagnosis(d, ctx()))).toBe(d);
  });
});

describe("settlement-file search", () => {
  it("computes edit distance", () => {
    expect(editDistance("MGW7300000039", "MGW7300000039")).toBe(0);
    expect(editDistance("MGW7300000039", "MGW7300000093")).toBe(2);
    expect(editDistance("MGW7300000039", "MGW730000039")).toBe(1);
  });
  it("never treats a near-identical reference alone as a match (refs are sequential)", () => {
    expect(similarity(4_000_000, 7_600_000, "MGW7300000039", "MGW7300000038")).toBeNull();
    expect(similarity(4_000_000, 4_000_000, "MGW7300000039", "MGW7300000093")).toMatch(/typo/);
    expect(similarity(4_000_000, 4_000_000, "MGW7300000039", "MGW7300000471")).toBe("same amount, different reference");
  });
});

describe("tidyDiagnosis", () => {
  it("caps list sizes and removes duplicate evidence ids", () => {
    const d = tidyDiagnosis(
      diagnosis({
        findings: Array.from({ length: 8 }, (_, i) => ({ text: `  Finding ${i}  `, evidence: ["a", "a", "b"] })),
        risks: ["1", "2", "3", "4"],
      }),
    );
    expect(d.findings).toHaveLength(5);
    expect(d.findings[0]).toEqual({ text: "Finding 0", evidence: ["a", "b"] });
    expect(d.risks).toHaveLength(3);
  });
});

describe("audit sentences for the Copilot", () => {
  const base = { actor: "accountant", entity: "reconciliation_item", entityId: "x" };
  it("describes investigations, acceptances and dismissals", () => {
    expect(
      describeAudit({ ...base, action: "ai.investigated", details: { gateway_ref: "MGW7300000023", bucket: "AMOUNT_MISMATCH", recommendation: "ESCALATE", confidence: "high" } }),
    ).toBe("Accountant ran the Reconciliation Copilot on MGW7300000023 (amount mismatch); it suggested: escalate to a person, high confidence");
    expect(describeAudit({ ...base, action: "ai.suggestion_accepted", details: { gateway_ref: "MGW7300000005", recommendation: "MARK_PAID" } })).toBe(
      "Accountant accepted the Copilot's suggestion on MGW7300000005: mark as paid",
    );
    expect(describeAudit({ ...base, action: "ai.suggestion_dismissed", details: { gateway_ref: "MGW7300000039", note: "Settles tomorrow" } })).toBe(
      "Accountant dismissed the Copilot's suggestion on MGW7300000039: Settles tomorrow",
    );
  });
});
