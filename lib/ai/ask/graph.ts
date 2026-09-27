// Ask Kosha as a LangGraph state machine:
//
//   START → agent ⇄ tools → compose → verify ─(failed once)→ agent (with the failures) → … → END
//
// agent: the model decides which read-only tools to call (at most MAX_TOOL_ROUNDS rounds).
// compose: structured output (text, optional linked table, sources, follow-ups).
// verify: every rupee figure and reference is checked against the tool results in code. On a
//         failure the model goes back to the agent step with the failures as a message, so it
//         can look up what it was missing (e.g. a total it tried to add up itself), not just
//         reword the same answer.

import { HumanMessage, SystemMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { ChatOpenAI } from "@langchain/openai";
import type { EvidenceBag } from "@/lib/ai/evidence";
import { ANSWER_PROMPT } from "@/lib/ai/ask/prompts";
import { answerSchema, tidyAnswer, type Answer } from "@/lib/ai/ask/schema";
import { answerFeedback, verifyAnswer, type AnswerVerification } from "@/lib/ai/ask/verify";
import type { Usage } from "@/lib/ai/recon-copilot/graph";

export const MAX_TOOL_ROUNDS = 4;
const ZERO: Usage = { input: 0, output: 0, total: 0 };

function usageOf(message: unknown): Usage {
  const u = (message as AIMessage | undefined)?.usage_metadata;
  return u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, total: u.total_tokens ?? 0 } : ZERO;
}

const AskState = Annotation.Root({
  ...MessagesAnnotation.spec,
  toolRounds: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  attempts: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  answer: Annotation<Answer | null>({ reducer: (_, b) => b, default: () => null }),
  verification: Annotation<AnswerVerification | null>({ reducer: (_, b) => b, default: () => null }),
  feedback: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  usage: Annotation<Usage>({ reducer: (a, b) => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total }), default: () => ZERO }),
});
export type AskStateType = typeof AskState.State;

export function buildAskGraph(model: ChatOpenAI, tools: StructuredToolInterface[], bag: EvidenceBag, systemPrompt: string, questionAmountsPaise: ReadonlySet<number>) {
  const withTools = model.bindTools(tools);
  const toolNode = new ToolNode(tools, { handleToolErrors: true });
  const structured = model.withStructuredOutput(answerSchema, { name: "answer", includeRaw: true });
  const system = new SystemMessage(systemPrompt);

  async function agent(state: AskStateType) {
    const runner = state.toolRounds >= MAX_TOOL_ROUNDS ? model : withTools;
    const ai = await runner.invoke([system, ...state.messages]);
    return { messages: [ai], usage: usageOf(ai) };
  }

  async function callTools(state: AskStateType) {
    const result = (await toolNode.invoke({ messages: state.messages })) as { messages: BaseMessage[] };
    return { messages: result.messages, toolRounds: 1 };
  }

  async function answer(state: AskStateType) {
    const { raw, parsed } = await structured.invoke([system, ...state.messages, new HumanMessage(ANSWER_PROMPT)]);
    return { answer: tidyAnswer(parsed), attempts: 1, usage: usageOf(raw), feedback: null };
  }

  function verify(state: AskStateType) {
    const v = verifyAnswer(state.answer!, { knownAmountsPaise: bag.knownAmounts, evidenceIds: bag.ids, usedTools: state.toolRounds > 0, questionAmountsPaise });
    if (!v.ok && state.attempts < 2) {
      const feedback = answerFeedback(v);
      return { verification: v, feedback, messages: [new HumanMessage(feedback)] };
    }
    return { verification: v };
  }

  return new StateGraph(AskState)
    .addNode("agent", agent)
    .addNode("tools", callTools)
    .addNode("compose", answer)
    .addNode("verify", verify)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", (s) => ((s.messages[s.messages.length - 1] as AIMessage | undefined)?.tool_calls?.length ? "tools" : "compose"), ["tools", "compose"])
    .addEdge("tools", "agent")
    .addEdge("compose", "verify")
    .addConditionalEdges("verify", (s) => (s.feedback ? "agent" : END), ["agent", END])
    .compile();
}
