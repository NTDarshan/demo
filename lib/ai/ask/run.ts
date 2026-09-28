// Answers one question, streaming progress events. Stateless on the server: the browser sends
// the recent conversation with each question, so follow-ups work on serverless hosting too.

import { AIMessage, HumanMessage, type ToolMessage } from "@langchain/core/messages";
import { ApiError } from "@/lib/api/errors";
import { aiConfig, chatModel } from "@/lib/ai/config";
import { EvidenceBag } from "@/lib/ai/evidence";
import { extractRupeeAmounts } from "@/lib/ai/recon-copilot/verify";
import { buildAskGraph, type AskStateType } from "@/lib/ai/ask/graph";
import { ASK_SYSTEM_PROMPT } from "@/lib/ai/ask/prompts";
import { askToolLabel, makeAskTools } from "@/lib/ai/ask/tools";
import type { AskEvent, AskResult, AskTurn } from "@/lib/ai/ask/types";
import type { Usage } from "@/lib/ai/recon-copilot/graph";
import { formatDate, isoDateIST } from "@/lib/dates";
import { termFor } from "@/lib/domain/terms";

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Asia/Kolkata" });

export async function askKosha(question: string, history: AskTurn[], emit: (e: AskEvent) => void, now = new Date()): Promise<AskResult> {
  const config = aiConfig();
  if (!config) throw new ApiError(503, "ai_unavailable", "Ask Kosha is off: OPENAI_API_KEY is not set on the server.");
  const started = Date.now();
  const today = isoDateIST(now);
  const term = termFor(today);
  const bag = new EvidenceBag();
  // Figures the user typed (a threshold like "more than ₹1,00,000") may be quoted back.
  const questionAmounts = new Set<number>();
  for (const text of [question, ...history.filter((t) => t.role === "user").map((t) => t.content)]) {
    for (const a of extractRupeeAmounts(text)) {
      bag.addAmount(a.paise);
      questionAmounts.add(a.paise);
    }
  }
  const graph = buildAskGraph(
    chatModel(config),
    makeAskTools(bag, today),
    bag,
    ASK_SYSTEM_PROMPT(today, `${WEEKDAY.format(now)} ${formatDate(today)}`, `${term.label} (${formatDate(term.from)} to ${formatDate(term.to)})`),
    questionAmounts,
  );

  const messages = [...history.slice(-8).map((t) => (t.role === "user" ? new HumanMessage(t.content) : new AIMessage(t.content))), new HumanMessage(question)];

  const lookups: AskResult["lookups"] = [];
  const pending = new Map<string, AskResult["lookups"][number]>();
  let answer: AskStateType["answer"] = null;
  let verification: AskStateType["verification"] = null;
  let usage: Usage = { input: 0, output: 0, total: 0 };
  let thinking = true;
  let writes = 0;

  emit({ type: "step", id: "think", label: "Working out what to look up", state: "running" });
  const stream = await graph.stream({ messages }, { streamMode: "updates", recursionLimit: 25 });
  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, Partial<AskStateType>>)) {
      if (update.usage) usage = { input: usage.input + update.usage.input, output: usage.output + update.usage.output, total: usage.total + update.usage.total };
      if (node === "agent") {
        if (thinking) {
          emit({ type: "step", id: "think", label: "Working out what to look up", state: "done" });
          thinking = false;
        }
        const ai = update.messages?.[0] as AIMessage | undefined;
        for (const call of ai?.tool_calls ?? []) {
          const l = { tool: call.name, label: askToolLabel(call.name, call.args), summary: null as string | null };
          pending.set(call.id ?? `${call.name}-${pending.size}`, l);
          lookups.push(l);
          emit({ type: "step", id: call.id ?? l.label, label: l.label, state: "running" });
        }
        if (!ai?.tool_calls?.length) emit({ type: "step", id: `answer-${writes + 1}`, label: "Writing the answer", state: "running" });
      } else if (node === "tools") {
        for (const m of (update.messages ?? []) as ToolMessage[]) {
          const l = pending.get(m.tool_call_id);
          let summary: string | null = null;
          let error = false;
          try {
            summary = (JSON.parse(String(m.content)) as { summary?: string }).summary ?? null;
          } catch {
            error = true;
            summary = String(m.content).slice(0, 140);
          }
          if (l) l.summary = summary;
          emit({ type: "step", id: m.tool_call_id, label: l?.label ?? m.name ?? "Lookup", state: error ? "error" : "done", detail: summary });
        }
      } else if (node === "compose") {
        writes += 1;
        answer = update.answer ?? null;
        emit({ type: "step", id: `answer-${writes}`, label: writes > 1 ? "Rewriting the answer" : "Writing the answer", state: "done" });
      } else if (node === "verify") {
        verification = update.verification ?? null;
        const v = verification!;
        emit({
          type: "step",
          id: `verify-${writes}`,
          label: v.ok ? "Checked every figure against the data" : update.feedback ? "A figure was not in the data; going back to check" : "Some figures could not be checked",
          state: v.ok ? "done" : "error",
          detail: v.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(" · "),
        });
        if (update.feedback) emit({ type: "step", id: `recheck-${writes}`, label: "Looking up what was missing", state: "done" });
      }
    }
  }
  if (!answer || !verification) throw new ApiError(502, "ai_no_result", "Ask Kosha did not produce an answer. Try again.");

  const result: AskResult = { ...answer, evidence: bag.list(), verification, lookups, model: config.model, usage, latencyMs: Date.now() - started };
  emit({ type: "done", result });
  return result;
}
