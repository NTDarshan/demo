// Deterministic checks on the Copilot's diagnosis. Pure functions, unit tested.
//
// A language model can misquote a number or suggest an action the rules forbid, so nothing
// it writes is shown as-is. Every rupee figure must be one the tools actually returned, every
// cited evidence id must exist, and the action must be allowed for the bucket and the
// payment's current status. The graph gives the model one chance to fix a failed check;
// if it still fails, the recommendation is downgraded to ESCALATE with low confidence.

import { toPaise } from "@/lib/money";
import type { Bucket } from "@/lib/domain/reconcile";
import type { PaymentStatus } from "@/lib/domain/payment-state";
import type { CopilotAction, Diagnosis } from "@/lib/ai/recon-copilot/schema";

/** What a person could do with this item right now (mirrors resolve_recon_item()). */
export function allowedActions(bucket: Bucket, paymentStatusNow: PaymentStatus | null): CopilotAction[] {
  if (bucket === "MATCHED") return [];
  if (bucket === "SETTLED_PENDING_HERE") {
    if (paymentStatusNow === "PENDING" || paymentStatusNow === "SUCCESS") return ["MARK_PAID", "MARK_REVIEWED", "ESCALATE"];
    return ["MARK_REVIEWED", "ESCALATE"];
  }
  // Amount mismatches and missing settlements are never fixed automatically.
  return ["MARK_REVIEWED", "ESCALATE"];
}

// "₹42,500", "₹ 1,25,000.50", "Rs. 500", "INR 500". Plain numbers without a currency marker
// are not treated as money (they are usually counts, days or line numbers).
const RUPEE_RE = /(?:₹|\bRs\.?|\bINR)\s?(\d[\d,]*(?:\.\d{1,2})?)/gi;

/** Every rupee amount written in the text, in paise. Unparseable figures come back as NaN. */
export function extractRupeeAmounts(text: string): { raw: string; paise: number }[] {
  const out: { raw: string; paise: number }[] = [];
  for (const m of text.matchAll(RUPEE_RE)) {
    const figure = m[1]!.replace(/,$/, "");
    const parsed = toPaise(figure);
    out.push({ raw: m[0].trim().replace(/,$/, ""), paise: parsed.ok ? parsed.paise : Number.NaN });
  }
  return out;
}

export type Check = { name: string; ok: boolean; detail: string };

export type Verification = {
  ok: boolean;
  checks: Check[];
  /** Amounts in the text that no tool returned. */
  unverifiedAmounts: string[];
  /** Evidence ids cited that no tool produced. */
  unknownEvidence: string[];
  /** Number of rupee figures that were checked and found in the evidence. */
  verifiedAmountCount: number;
};

export type VerifyContext = {
  bucket: Bucket;
  paymentStatusNow: PaymentStatus | null;
  knownAmountsPaise: ReadonlySet<number>;
  evidenceIds: ReadonlySet<string>;
  /** Set when a tool found another payment that may be the same money paid twice. */
  duplicateSuspected: boolean;
};

function textsOf(d: Diagnosis): string[] {
  return [
    d.headline,
    ...d.findings.map((f) => f.text),
    d.recommendation.reason,
    d.recommendation.note,
    d.gatewayQuery,
    ...d.nextSteps,
    ...d.risks,
  ];
}

export function verifyDiagnosis(d: Diagnosis, ctx: VerifyContext): Verification {
  const checks: Check[] = [];

  const allowed = allowedActions(ctx.bucket, ctx.paymentStatusNow);
  const actionOk = allowed.includes(d.recommendation.action);
  checks.push({
    name: "Action allowed",
    ok: actionOk,
    detail: actionOk
      ? `${d.recommendation.action} is allowed for this item.`
      : `${d.recommendation.action} is not allowed here. Allowed: ${allowed.join(", ") || "none"}.`,
  });

  const amounts = textsOf(d).flatMap(extractRupeeAmounts);
  const unverified = [...new Set(amounts.filter((a) => !ctx.knownAmountsPaise.has(a.paise)).map((a) => a.raw))];
  checks.push({
    name: "Figures match the database",
    ok: unverified.length === 0,
    detail:
      unverified.length === 0
        ? amounts.length === 0
          ? "No rupee figures to check."
          : `All ${amounts.length} rupee figure${amounts.length === 1 ? "" : "s"} appear in the evidence.`
        : `Not found in any tool result: ${unverified.join(", ")}.`,
  });

  const cited = d.findings.flatMap((f) => f.evidence);
  const unknown = [...new Set(cited.filter((id) => !ctx.evidenceIds.has(id)))];
  const uncited = d.findings.filter((f) => f.evidence.length === 0).length;
  checks.push({
    name: "Findings cite evidence",
    ok: unknown.length === 0 && uncited === 0 && d.findings.length > 0,
    detail:
      d.findings.length === 0
        ? "No findings were given."
        : unknown.length > 0
          ? `Unknown evidence ids: ${unknown.join(", ")}.`
          : uncited > 0
            ? `${uncited} finding${uncited === 1 ? " has" : "s have"} no evidence.`
            : `Every finding cites evidence the tools returned.`,
  });

  if (ctx.duplicateSuspected && d.recommendation.action === "MARK_PAID") {
    // Must be raised as a risk or a next step. Searching all the text would also accept a
    // diagnosis that says "no duplicate", which is the opposite of what the tools found.
    const mentioned = [...d.risks, ...d.nextSteps].some((t) => /duplicate|twice|again|second payment|retr/i.test(t));
    checks.push({
      name: "Duplicate risk disclosed",
      ok: mentioned,
      detail: mentioned
        ? "The possible duplicate payment is mentioned."
        : "Another payment of the same amount exists; marking as paid could double-count it. Say so in risks or next steps.",
    });
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    unverifiedAmounts: unverified,
    unknownEvidence: unknown,
    verifiedAmountCount: amounts.length - amounts.filter((a) => !ctx.knownAmountsPaise.has(a.paise)).length,
  };
}

/** Feedback for the model's second attempt. */
export function feedbackFor(v: Verification): string {
  const failed = v.checks.filter((c) => !c.ok).map((c) => `- ${c.name}: ${c.detail}`);
  return [
    "Your diagnosis failed these automatic checks:",
    ...failed,
    "Rewrite it. Quote only figures that appear in tool results, cite only evidence ids that tools returned, and choose an allowed action.",
  ].join("\n");
}

/** Last line of defence after the retry: never let an unverified suggestion look confident. */
export function downgrade(d: Diagnosis, v: Verification): Diagnosis {
  if (v.ok) return d;
  const actionBad = v.checks.some((c) => c.name === "Action allowed" && !c.ok);
  return {
    ...d,
    confidence: "low",
    recommendation: actionBad
      ? { action: "ESCALATE", reason: `The Copilot's first suggestion was not allowed for this item. ${d.recommendation.reason}`, note: d.recommendation.note }
      : d.recommendation,
  };
}
