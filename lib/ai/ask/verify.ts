// Deterministic checks on an Ask Kosha answer. Pure, unit tested.
// Every rupee figure (in the text and the table) must be one the tools returned, and every
// source or table row must point at a record a tool returned.

import type { Answer } from "@/lib/ai/ask/schema";
import { extractRupeeAmounts, type Check } from "@/lib/ai/recon-copilot/verify";

export type AnswerVerification = { ok: boolean; checks: Check[]; unverifiedAmounts: string[]; verifiedAmountCount: number };

export type AnswerContext = {
  knownAmountsPaise: ReadonlySet<number>;
  evidenceIds: ReadonlySet<string>;
  usedTools: boolean;
  /** Figures the user typed; quoting them back needs no lookup. */
  questionAmountsPaise: ReadonlySet<number>;
};

export function verifyAnswer(a: Answer, ctx: AnswerContext): AnswerVerification {
  const { knownAmountsPaise, evidenceIds, usedTools } = ctx;
  const texts = [a.answer, a.table.title, ...a.table.rows.flatMap((r) => r.cells)];
  const amounts = texts.flatMap(extractRupeeAmounts);
  const unverified = [...new Set(amounts.filter((x) => !knownAmountsPaise.has(x.paise)).map((x) => x.raw))];
  const refs = [...a.sources, ...a.table.rows.map((r) => r.ref).filter(Boolean)];
  const unknown = [...new Set(refs.filter((r) => !evidenceIds.has(r)))];

  const checks: Check[] = [
    {
      name: "Figures match the database",
      ok: unverified.length === 0,
      detail: unverified.length === 0 ? (amounts.length ? `All ${amounts.length} rupee figure${amounts.length === 1 ? "" : "s"} came from the data or the question.` : "No rupee figures to check.") : `Not found in the data: ${unverified.join(", ")}.`,
    },
    {
      name: "Sources exist",
      ok: unknown.length === 0,
      detail: unknown.length === 0 ? "Every source and table row points at a record the tools returned." : `Unknown references: ${unknown.join(", ")}.`,
    },
  ];
  // A money answer with no lookup at all is a guess.
  if (!usedTools && amounts.some((x) => !ctx.questionAmountsPaise.has(x.paise))) checks.push({ name: "Answer is looked up", ok: false, detail: "Rupee figures were given without reading the data." });

  return { ok: checks.every((c) => c.ok), checks, unverifiedAmounts: unverified, verifiedAmountCount: amounts.length - amounts.filter((x) => !knownAmountsPaise.has(x.paise)).length };
}

export function answerFeedback(v: AnswerVerification): string {
  return [
    "Your answer failed these automatic checks:",
    ...v.checks.filter((c) => !c.ok).map((c) => `- ${c.name}: ${c.detail}`),
    "Fix it. If a figure is missing, call a tool that returns it (for example search_students with the combined filters returns totals for everyone matched) instead of adding numbers up yourself. Copy figures exactly from tool results and cite only evidence ids the tools returned.",
  ].join("\n");
}
