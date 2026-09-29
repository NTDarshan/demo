// The daily finance brief: "the three things that need attention today".
//
//   START → collect → compose → review ─(failed, first try)→ compose (with the failures) → END
//
// collect: signals computed in code from the ledger (signals.ts).
// compose: the model picks the three that matter most and writes a headline and one reason
//          each. Titles, figures, examples and links stay the code's; the model's words are
//          only the headline and the reasons.
// review:  checks the picks exist, the actions belong to the signal, and every rupee figure
//          in the model's words is one of the signal's figures.
// Without an OpenAI key (or if the model fails) the brief is written by rules instead, so the
// dashboard always has one.

import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { aiConfig, chatModel } from "@/lib/ai/config";
import { computeSignals, signalsFingerprint, type BriefInput, type Signal } from "@/lib/ai/brief/signals";
import { extractRupeeAmounts, type Check } from "@/lib/ai/recon-copilot/verify";
import { formatDate } from "@/lib/dates";

export type BriefItem = { signalId: Signal["id"]; why: string; actionId: string };
export type BriefContent = {
  date: string;
  headline: string;
  items: BriefItem[];
  generatedBy: "ai" | "rules";
  checks: Check[];
  fingerprint: string;
  signals: Signal[];
  model: string | null;
  usage: { input: number; output: number; total: number };
  latencyMs: number;
};

const pickSchema = z.object({
  headline: z.string().describe("One sentence, under 25 words, summing up what needs doing today."),
  picks: z
    .array(
      z.object({
        signalId: z.string().describe("The id of a signal from the list."),
        why: z.string().describe("One or two sentences: why this matters today and what happens if it waits. Use only figures from that signal."),
        actionId: z.string().describe("The id of one of that signal's actions."),
      }),
    )
    .describe("The three signals that most need attention today, most urgent first (fewer if there are fewer signals)."),
});

const SYSTEM = `You write the morning brief for the accounts office of an Indian college, inside Kosha, its fee ledger.
You get a list of signals found in the ledger today, each with an id, a severity score from code, a title, facts and possible actions.
Pick the three that most need a person's attention today and say why in plain, specific words for an accountant.
- Money at risk or parents left waiting (payments stuck in pending, exceptions with a shortfall) usually comes before routine reminders; use the severity score as a guide, but you may reorder with a good reason.
- Use only figures that appear in that signal's title or facts, written exactly as given (e.g. ₹1,62,500). Do not add, subtract or round.
- Choose each action from that signal's actions by id. Do not invent actions, links, names or deadlines.
- Be brief and calm: say plainly what to do and why. No greetings, no AI talk, no alarmist phrases such as "revenue loss" or "secure".`;

const WHY: Record<Signal["id"], string> = {
  pending_stuck: "Parents believe they have paid; confirm with the gateway so receipts are issued and nobody pays twice.",
  recon_open: "Unresolved exceptions leave the books out of step with the bank; each one needs a decision.",
  newly_overdue: "A reminder in the first week after the due date is the most effective one.",
  long_overdue: "Dues this old need a personal follow-up with the parents.",
  due_soon: "A reminder before the due date prevents overdue fees.",
  collections_drop: "Collections fell sharply against the previous week; check whether payments are failing or pending.",
  collections_up: "Collections are on track.",
  failures: "Failed or reversed payments mean the fees are still owed; the parents may not know.",
  advances: "Advances should be adjusted against the next installment or refunded.",
};

export function rulesBrief(signals: Signal[], date: string): Pick<BriefContent, "headline" | "items" | "generatedBy"> {
  const top = signals.filter((s) => s.severity >= 20).slice(0, 3);
  const items = (top.length ? top : signals.slice(0, 1)).map((s) => ({ signalId: s.id, why: WHY[s.id], actionId: s.actions[0]?.id ?? "" }));
  const headline = top.length === 0 ? `Nothing urgent in the ledger on ${formatDate(date)}.` : `${top.length === 1 ? "One thing needs" : `${top.length} things need`} attention today, starting with: ${top[0]!.title.charAt(0).toLowerCase()}${top[0]!.title.slice(1)}.`;
  return { headline, items, generatedBy: "rules" };
}

export function reviewBrief(content: { headline: string; items: BriefItem[] }, signals: Signal[]): Check[] {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const want = Math.min(3, signals.length);
  const ids = content.items.map((i) => i.signalId);
  const unknown = ids.filter((id) => !byId.has(id));
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const badActions = content.items.filter((i) => byId.has(i.signalId) && !byId.get(i.signalId)!.actions.some((a) => a.id === i.actionId));
  const known = new Set(signals.flatMap((s) => s.amountsPaise.map((a) => Math.abs(a))));
  const figures = [content.headline, ...content.items.map((i) => i.why)].flatMap(extractRupeeAmounts);
  const unverified = [...new Set(figures.filter((f) => !known.has(f.paise)).map((f) => f.raw))];
  // Each reason may only use its own signal's figures.
  const crossed = content.items.filter((i) => {
    const own = new Set((byId.get(i.signalId)?.amountsPaise ?? []).map((a) => Math.abs(a)));
    return extractRupeeAmounts(i.why).some((f) => !own.has(f.paise));
  });
  return [
    { name: "Picks are real signals", ok: unknown.length === 0 && dupes.length === 0 && ids.length === want, detail: unknown.length ? `Unknown: ${unknown.join(", ")}.` : dupes.length ? "A signal was picked twice." : ids.length !== want ? `Expected ${want} picks, got ${ids.length}.` : `${ids.length} signals picked from ${signals.length}.` },
    { name: "Actions belong to their signal", ok: badActions.length === 0, detail: badActions.length ? `Not an action of ${badActions.map((b) => b.signalId).join(", ")}.` : "Every action comes from its signal." },
    { name: "Figures match the ledger", ok: unverified.length === 0 && crossed.length === 0, detail: unverified.length ? `Not in the ledger: ${unverified.join(", ")}.` : crossed.length ? `A reason uses another signal's figure (${crossed.map((c) => c.signalId).join(", ")}).` : `${figures.length} figure${figures.length === 1 ? "" : "s"} checked.` },
  ];
}

const State = Annotation.Root({
  signals: Annotation<Signal[]>({ reducer: (_, b) => b, default: () => [] }),
  proposal: Annotation<{ headline: string; items: BriefItem[] } | null>({ reducer: (_, b) => b, default: () => null }),
  checks: Annotation<Check[]>({ reducer: (_, b) => b, default: () => [] }),
  feedback: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  attempts: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  usage: Annotation<{ input: number; output: number; total: number }>({
    reducer: (a, b) => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total }),
    default: () => ({ input: 0, output: 0, total: 0 }),
  }),
});

export async function writeBrief(input: BriefInput): Promise<BriefContent> {
  const started = Date.now();
  const config = aiConfig();

  const collect = () => ({ signals: computeSignals(input) });

  function finalise(state: typeof State.State, generatedBy: "ai" | "rules", model: string | null): BriefContent {
    const base = generatedBy === "ai" && state.proposal ? { ...state.proposal, generatedBy } : rulesBrief(state.signals, input.today);
    return {
      date: input.today,
      ...base,
      checks: generatedBy === "ai" ? state.checks : reviewBrief(base, state.signals),
      fingerprint: signalsFingerprint(state.signals),
      signals: state.signals,
      model,
      usage: state.usage,
      latencyMs: Date.now() - started,
    };
  }

  if (!config) {
    return finalise({ ...(await new StateGraph(State).addNode("collect", collect).addEdge(START, "collect").addEdge("collect", END).compile().invoke({})) }, "rules", null);
  }

  const model = chatModel(config).withStructuredOutput(pickSchema, { name: "brief", includeRaw: true });

  async function compose(state: typeof State.State) {
    if (state.signals.length === 0) return { proposal: { headline: `Nothing needs attention in the ledger on ${formatDate(input.today)}.`, items: [] }, attempts: 1 };
    const list = state.signals.map((s) => ({ id: s.id, severity: s.severity, title: s.title, facts: s.facts, actions: s.actions.map((a) => ({ id: a.id, label: a.label })) }));
    const msgs = [new SystemMessage(SYSTEM), new HumanMessage(`Today is ${formatDate(input.today)}. Signals:\n${JSON.stringify(list, null, 1)}`)];
    if (state.feedback) msgs.push(new HumanMessage(state.feedback));
    const { raw, parsed } = await model.invoke(msgs);
    const u = (raw as AIMessage).usage_metadata;
    const items = parsed.picks.slice(0, 3).map((p) => ({ signalId: p.signalId as Signal["id"], why: p.why.trim().slice(0, 400), actionId: p.actionId }));
    return { proposal: { headline: parsed.headline.trim().slice(0, 240), items }, attempts: 1, feedback: null, usage: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, total: u?.total_tokens ?? 0 } };
  }

  function review(state: typeof State.State) {
    const checks = reviewBrief(state.proposal!, state.signals);
    if (checks.every((c) => c.ok) || state.attempts >= 2) return { checks };
    return { checks, feedback: ["Your brief failed these checks:", ...checks.filter((c) => !c.ok).map((c) => `- ${c.name}: ${c.detail}`), "Fix it using only the signals given."].join("\n") };
  }

  try {
    const final = await new StateGraph(State)
      .addNode("collect", collect)
      .addNode("compose", compose)
      .addNode("review", review)
      .addEdge(START, "collect")
      .addEdge("collect", "compose")
      .addEdge("compose", "review")
      .addConditionalEdges("review", (s) => (s.feedback ? "compose" : END), ["compose", END])
      .compile()
      .invoke({}, { recursionLimit: 12 });
    // A brief that still fails its checks is replaced by the rules brief rather than shown.
    if (!final.checks.every((c) => c.ok)) return finalise(final, "rules", config.model);
    return finalise(final, "ai", config.model);
  } catch (err) {
    console.error("Daily brief: the model failed, using the rules brief", err);
    return finalise({ signals: computeSignals(input), proposal: null, checks: [], feedback: null, attempts: 0, usage: { input: 0, output: 0, total: 0 } }, "rules", null);
  }
}
