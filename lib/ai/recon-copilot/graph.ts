// The Reconciliation Copilot as a LangGraph state machine.
//
//   START → investigate ⇄ tools        the model calls read-only tools to gather evidence
//              │                        (at most MAX_TOOL_ROUNDS rounds)
//              ▼
//           diagnose                    structured output: headline, cause, findings, action
//              │
//              ▼
//           verify ──(failed, 1st try)──► diagnose again, with the failures as feedback
//              │
//              ▼
//             END                       still failing → downgraded to ESCALATE / low confidence
//
// The graph only proposes. Accepting the proposal is a separate request made by a person,
// which runs decide_ai_investigation() → resolve_recon_item() in the database.

import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { ChatOpenAI } from "@langchain/openai";
import { caseBrief, type CaseFile, type EvidenceBag } from "@/lib/ai/recon-copilot/case-file";
import { DIAGNOSE_PROMPT, SYSTEM_PROMPT } from "@/lib/ai/recon-copilot/prompts";
import { diagnosisSchema, tidyDiagnosis, type Diagnosis } from "@/lib/ai/recon-copilot/schema";
import { makeTools } from "@/lib/ai/recon-copilot/tools";
import { allowedActions, downgrade, feedbackFor, verifyDiagnosis, type Verification } from "@/lib/ai/recon-copilot/verify";

export const MAX_TOOL_ROUNDS = 5;
export const MAX_DIAGNOSE_ATTEMPTS = 2;

export type Usage = { input: number; output: number; total: number };
const ZERO: Usage = { input: 0, output: 0, total: 0 };
const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total });

function usageOf(message: unknown): Usage {
  const u = (message as AIMessage | undefined)?.usage_metadata;
  return u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, total: u.total_tokens ?? 0 } : ZERO;
}

const CopilotState = Annotation.Root({
  ...MessagesAnnotation.spec,
  toolRounds: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  attempts: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  diagnosis: Annotation<Diagnosis | null>({ reducer: (_, b) => b, default: () => null }),
  verification: Annotation<Verification | null>({ reducer: (_, b) => b, default: () => null }),
  feedback: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  usage: Annotation<Usage>({ reducer: addUsage, default: () => ZERO }),
});
export type CopilotStateType = typeof CopilotState.State;

export function buildCopilotGraph(model: ChatOpenAI, c: CaseFile, bag: EvidenceBag) {
  const tools = makeTools(c, bag);
  const withTools = model.bindTools(tools);
  const toolNode = new ToolNode(tools, { handleToolErrors: true });
  const structured = model.withStructuredOutput(diagnosisSchema, { name: "diagnosis", includeRaw: true });
  const allowed = allowedActions(c.bucket, c.paymentStatusNow);
  const system = new SystemMessage(SYSTEM_PROMPT(allowed));

  async function investigate(state: CopilotStateType) {
    // After the tool budget is spent, ask once more without tools so the model wraps up.
    const runner = state.toolRounds >= MAX_TOOL_ROUNDS ? model : withTools;
    const ai = await runner.invoke([system, ...state.messages]);
    return { messages: [ai], usage: usageOf(ai) };
  }

  async function callTools(state: CopilotStateType) {
    const result = await toolNode.invoke({ messages: state.messages });
    return { messages: (result as { messages: BaseMessage[] }).messages, toolRounds: 1 };
  }

  async function diagnose(state: CopilotStateType) {
    const ask = new HumanMessage(state.feedback ? `${DIAGNOSE_PROMPT}\n\n${state.feedback}` : DIAGNOSE_PROMPT);
    const { raw, parsed } = await structured.invoke([system, ...state.messages, ask]);
    return { diagnosis: tidyDiagnosis(parsed), attempts: 1, usage: usageOf(raw), feedback: null };
  }

  function verify(state: CopilotStateType) {
    const d = state.diagnosis!;
    const v = verifyDiagnosis(d, {
      bucket: c.bucket,
      paymentStatusNow: c.paymentStatusNow,
      knownAmountsPaise: bag.knownAmounts,
      evidenceIds: bag.ids,
      duplicateSuspected: bag.duplicateSuspected,
    });
    if (!v.ok && state.attempts < MAX_DIAGNOSE_ATTEMPTS) return { verification: v, feedback: feedbackFor(v) };
    return { verification: v, diagnosis: downgrade(d, v) };
  }

  return new StateGraph(CopilotState)
    .addNode("investigate", investigate)
    .addNode("tools", callTools)
    .addNode("diagnose", diagnose)
    .addNode("verify", verify)
    .addEdge(START, "investigate")
    .addConditionalEdges("investigate", (s) => {
      const last = s.messages[s.messages.length - 1] as AIMessage | undefined;
      return last?.tool_calls?.length ? "tools" : "diagnose";
    }, ["tools", "diagnose"])
    .addEdge("tools", "investigate")
    .addEdge("diagnose", "verify")
    .addConditionalEdges("verify", (s) => (s.feedback ? "diagnose" : END), ["diagnose", END])
    .compile();
}

export function initialMessages(c: CaseFile, bag: EvidenceBag): BaseMessage[] {
  return [new HumanMessage(caseBrief(c, bag))];
}
