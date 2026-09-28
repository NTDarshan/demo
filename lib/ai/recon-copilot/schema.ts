// What the Reconciliation Copilot returns. The model fills this schema through OpenAI's
// structured output, then lib/ai/recon-copilot/verify.ts checks it against the database
// before anyone sees it.
//
// No min/max constraints here: OpenAI's strict JSON schema mode rejects some of them.
// Lengths are enforced after parsing, in tidyDiagnosis().

import { z } from "zod";

export const ACTIONS = ["MARK_PAID", "MARK_REVIEWED", "ESCALATE"] as const;
export type CopilotAction = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<CopilotAction, string> = {
  MARK_PAID: "Mark as paid",
  MARK_REVIEWED: "Mark as reviewed",
  ESCALATE: "Escalate to a person",
};

export const ROOT_CAUSES = [
  "GATEWAY_CONFIRMED_LATE",
  "SETTLEMENT_SHORT",
  "SETTLEMENT_EXCESS",
  "LATE_OR_NEXT_BATCH",
  "POSSIBLE_DUPLICATE",
  "REFERENCE_TYPO",
  "GATEWAY_DISAGREES",
  "UNKNOWN",
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export const ROOT_CAUSE_LABEL: Record<RootCause, string> = {
  GATEWAY_CONFIRMED_LATE: "Gateway confirmed after we timed out",
  SETTLEMENT_SHORT: "Gateway settled less than was paid",
  SETTLEMENT_EXCESS: "Gateway settled more than was paid",
  LATE_OR_NEXT_BATCH: "Settles in a later batch",
  POSSIBLE_DUPLICATE: "Possible duplicate payment",
  REFERENCE_TYPO: "Reference typed wrongly in the file",
  GATEWAY_DISAGREES: "Gateway record disagrees with ours",
  UNKNOWN: "Cause not clear",
};

export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const diagnosisSchema = z.object({
  headline: z.string().describe("One sentence, under 25 words, saying what most likely happened. Plain English for an accountant."),
  rootCause: z.enum(ROOT_CAUSES).describe("The single most likely cause."),
  confidence: z.enum(CONFIDENCE).describe("high only if the evidence directly shows the cause; low if you are guessing."),
  findings: z
    .array(
      z.object({
        text: z.string().describe("One fact you established, with the exact figures and dates from the tools."),
        evidence: z.array(z.string()).describe("Evidence ids from the tool results that show this fact, e.g. gateway:MGW7300000012."),
      }),
    )
    .describe("2 to 5 findings, most important first."),
  recommendation: z.object({
    action: z.enum(ACTIONS).describe("Must be one of the allowed actions listed for this case."),
    reason: z.string().describe("Why this action, in one or two sentences."),
    note: z.string().describe("The resolution note to save on the item if the accountant accepts, under 200 characters. Mention what was checked."),
  }),
  gatewayQuery: z
    .string()
    .describe(
      "If a person needs to ask the payment gateway, a short ready-to-send message to the gateway's support desk quoting the reference, amounts and dates. Empty string if no question for the gateway is needed.",
    ),
  nextSteps: z.array(z.string()).describe("0 to 3 short follow-ups for a person, e.g. 'Raise a ticket with the gateway for the ₹500 shortfall'."),
  risks: z.array(z.string()).describe("0 to 3 things that could make this recommendation wrong."),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Trims lengths and list sizes the schema cannot enforce. */
export function tidyDiagnosis(d: Diagnosis): Diagnosis {
  return {
    headline: clip(d.headline.trim(), 220),
    rootCause: d.rootCause,
    confidence: d.confidence,
    findings: d.findings.slice(0, 5).map((f) => ({ text: clip(f.text.trim(), 400), evidence: [...new Set(f.evidence.map((e) => e.trim()))].slice(0, 6) })),
    recommendation: {
      action: d.recommendation.action,
      reason: clip(d.recommendation.reason.trim(), 400),
      note: clip(d.recommendation.note.trim(), 300),
    },
    gatewayQuery: clip(d.gatewayQuery.trim(), 900),
    nextSteps: d.nextSteps.slice(0, 3).map((s) => clip(s.trim(), 200)),
    risks: d.risks.slice(0, 3).map((s) => clip(s.trim(), 200)),
  };
}
