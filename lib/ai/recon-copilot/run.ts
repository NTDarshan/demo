// Runs one investigation end to end: load the case, stream the graph, save the proposal.
// `emit` receives progress events as the agent works, so the UI can show each step live.

import type { AIMessage, ToolMessage } from "@langchain/core/messages";
import { ApiError } from "@/lib/api/errors";
import { aiConfig, chatModel } from "@/lib/ai/config";
import { EvidenceBag, loadCaseFile } from "@/lib/ai/recon-copilot/case-file";
import { buildCopilotGraph, initialMessages, type CopilotStateType, type Usage } from "@/lib/ai/recon-copilot/graph";
import { toolLabel } from "@/lib/ai/recon-copilot/tools";
import type { CopilotEvent, Investigation, TraceStep } from "@/lib/ai/recon-copilot/types";
import { saveInvestigation } from "@/lib/data/ai";
import type { Role } from "@/lib/auth/permissions";

function toolSummary(content: unknown): { summary: string | null; error: boolean } {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  try {
    const parsed = JSON.parse(text) as { summary?: unknown };
    return { summary: typeof parsed.summary === "string" ? parsed.summary : null, error: false };
  } catch {
    // ToolNode turns a thrown error into a plain-text message.
    return { summary: text.slice(0, 140), error: true };
  }
}

export async function investigateReconItem(itemId: string, actor: Role, emit: (e: CopilotEvent) => void): Promise<Investigation> {
  const config = aiConfig();
  if (!config) throw new ApiError(503, "ai_unavailable", "The Copilot is off: OPENAI_API_KEY is not set on the server.");
  const started = Date.now();

  emit({ type: "step", id: "load", label: "Reading the exception and the payment", state: "running" });
  const c = await loadCaseFile(itemId);
  const bag = new EvidenceBag();
  emit({ type: "step", id: "load", label: "Reading the exception and the payment", state: "done", detail: `${c.gatewayRef}${c.student ? ` · ${c.student.name}` : ""}` });

  const graph = buildCopilotGraph(chatModel(config), c, bag);
  const trace: TraceStep[] = [];
  const pending = new Map<string, TraceStep>();
  let final: Partial<CopilotStateType> = {};
  let usage: Usage = { input: 0, output: 0, total: 0 };
  let verifyRound = 0;

  const stream = await graph.stream({ messages: initialMessages(c, bag) }, { streamMode: "updates", recursionLimit: 30 });
  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, Partial<CopilotStateType>>)) {
      if (update.usage) usage = { input: usage.input + update.usage.input, output: usage.output + update.usage.output, total: usage.total + update.usage.total };
      if (node === "investigate") {
        const ai = update.messages?.[0] as AIMessage | undefined;
        for (const call of ai?.tool_calls ?? []) {
          const step: TraceStep = { tool: call.name, label: toolLabel(call.name, call.args), args: call.args, summary: null, error: false };
          pending.set(call.id ?? `${call.name}-${pending.size}`, step);
          trace.push(step);
          emit({ type: "step", id: call.id ?? step.label, label: step.label, state: "running" });
        }
        if (!ai?.tool_calls?.length) emit({ type: "step", id: `diagnose-${verifyRound + 1}`, label: verifyRound ? "Rewriting the diagnosis" : "Writing the diagnosis", state: "running" });
      } else if (node === "tools") {
        for (const m of (update.messages ?? []) as ToolMessage[]) {
          const step = pending.get(m.tool_call_id);
          const { summary, error } = toolSummary(m.content);
          if (step) {
            step.summary = summary;
            step.error = error;
          }
          emit({ type: "step", id: m.tool_call_id, label: step?.label ?? m.name ?? "Tool", state: error ? "error" : "done", detail: summary });
        }
      } else if (node === "diagnose") {
        final = { ...final, diagnosis: update.diagnosis ?? null };
        emit({ type: "step", id: `diagnose-${verifyRound + 1}`, label: verifyRound ? "Rewriting the diagnosis" : "Writing the diagnosis", state: "done" });
        verifyRound += 1;
        emit({ type: "step", id: `verify-${verifyRound}`, label: "Checking every figure against the database", state: "running" });
      } else if (node === "verify") {
        final = { ...final, verification: update.verification ?? null, ...(update.diagnosis ? { diagnosis: update.diagnosis } : {}) };
        const v = update.verification!;
        emit({
          type: "step",
          id: `verify-${verifyRound}`,
          label: v.ok ? "All checks passed" : update.feedback ? "A check failed, asking the Copilot to correct it" : "Some checks failed; confidence lowered",
          state: v.ok ? "done" : "error",
          detail: v.checks.map((ch) => `${ch.ok ? "✓" : "✗"} ${ch.name}`).join(" · "),
        });
        if (update.feedback) emit({ type: "step", id: `diagnose-${verifyRound + 1}`, label: "Rewriting the diagnosis", state: "running" });
      }
    }
  }

  if (!final.diagnosis || !final.verification) throw new ApiError(502, "ai_no_result", "The Copilot did not produce a diagnosis. Try again.");
  const d = final.diagnosis;
  const investigation = await saveInvestigation({
    itemId,
    actor,
    diagnosis: d,
    evidence: bag.list(),
    verification: final.verification,
    trace,
    model: config.model,
    usage,
    latencyMs: Date.now() - started,
  });
  emit({ type: "done", investigation });
  return investigation;
}
