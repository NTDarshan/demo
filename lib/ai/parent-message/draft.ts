// Drafts a message to a student's parent: a small LangGraph loop.
//
//   START → write → check ─(failed, first try)→ write (with the failures) → END
//
// The facts come from the ledger in code (facts.ts). The model writes the words in the chosen
// language; check (verify.ts) confirms every amount is from the ledger, the key amount is
// there, and the language and length are right. Kosha never sends the message: staff copy it.

import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { aiConfig, chatModel } from "@/lib/ai/config";
import { LANGUAGE_NAME, PURPOSE_LABEL, type Channel, type Language, type MessageFacts, type Purpose, type PurposeCheck } from "@/lib/ai/parent-message/facts";
import { verifyMessage, WHATSAPP_MAX, type MessageVerification } from "@/lib/ai/parent-message/verify";

const draftSchema = z.object({
  subject: z.string().describe("Email subject line in the message's language. Empty string for WhatsApp."),
  message: z.string().describe("The message itself, ready to send."),
  englishGist: z.string().describe("For Kannada or Hindi: a faithful English translation of the message, so staff can check it. Empty string when the message is in English."),
});
export type Draft = z.infer<typeof draftSchema>;

export type DraftResult = Draft & {
  verification: MessageVerification;
  facts: MessageFacts;
  amountsPaise: number[];
  keyFigure: string | null;
  attempts: number;
  model: string;
  usage: { input: number; output: number; total: number };
  latencyMs: number;
};

const PURPOSE_BRIEF: Record<Purpose, string> = {
  REMINDER: "A polite reminder of the next installment falling due: the amount and the due date, and how to pay. If something is also overdue, mention it briefly.",
  OVERDUE: "A clear but respectful notice that fees are overdue: the overdue amount, since when, which installments, and a request to pay soon or contact the accounts office. No threats, no penalties (the college does not charge late fees).",
  BALANCE: "Explain the student's fee position simply: total fees, any concession, what has been paid, and what is outstanding (or held as advance), plus the next due date if any.",
  THANK_YOU: "Confirm the most recent payment was received: amount, date, receipt number and what it paid for, and the remaining balance if any.",
};

const SYSTEM = `You write messages from the Accounts Office of Nandi Hills College (India) to a student's parent or guardian about fees.
Rules:
- Use ONLY the facts provided. Never invent amounts, dates, fees, penalties, bank details, links, phone numbers or names.
- Write every amount exactly as given, with the ₹ sign and 0-9 digits (e.g. ₹84,000), in every language. Never spell amounts in words and never use Kannada or Devanagari digits.
- Keep dates as given (e.g. 15 Aug 2026); in Kannada or Hindi you may write the month name in that language.
- Address the parent respectfully (e.g. "Dear Parent" / "ಪೋಷಕರೇ" / "आदरणीय अभिभावक"), mention the student's name and roll number, and sign off as "Accounts Office, Nandi Hills College".
- Kannada and Hindi must be natural, everyday language a parent would use, not a word-for-word translation. Common English words such as "UPI", "online", "receipt" may stay in English.
- Never guess the student's gender from the name: the facts do not say it. Write "your ward" or use the student's name (Kannada: "ನಿಮ್ಮ ಮಗು" or the name; Hindi: "आपके पाल्य" or the name), never son/daughter, he/she, ಮಗ/ಮಗಳು or पुत्र/पुत्री.
- Do not include anything the parent must not see, such as internal ids or gateway references for pending payments.`;

const State = Annotation.Root({
  draft: Annotation<Draft | null>({ reducer: (_, b) => b, default: () => null }),
  verification: Annotation<MessageVerification | null>({ reducer: (_, b) => b, default: () => null }),
  feedback: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  attempts: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  usage: Annotation<{ input: number; output: number; total: number }>({
    reducer: (a, b) => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total }),
    default: () => ({ input: 0, output: 0, total: 0 }),
  }),
});

export async function draftParentMessage(input: {
  facts: MessageFacts;
  amountsPaise: number[];
  purpose: Purpose;
  check: PurposeCheck;
  language: Language;
  channel: Channel;
}): Promise<DraftResult> {
  const config = aiConfig();
  if (!config) throw new ApiError(503, "ai_unavailable", "Message drafting is off: OPENAI_API_KEY is not set on the server.");
  if (!input.check.available) throw new ApiError(422, "purpose_unavailable", input.check.reason ?? "That message does not apply to this student.");
  const started = Date.now();
  const model = chatModel(config).withStructuredOutput(draftSchema, { name: "draft", includeRaw: true });
  const amounts = new Set(input.amountsPaise);
  const brief = [
    `Write a ${input.channel === "whatsapp" ? `WhatsApp message (under ${Math.round(WHATSAPP_MAX * 0.8)} characters, short paragraphs, no markdown)` : "email (subject plus a short body)"} in ${LANGUAGE_NAME[input.language]}.`,
    `Purpose: ${PURPOSE_LABEL[input.purpose]}. ${PURPOSE_BRIEF[input.purpose]}`,
    input.check.keyFigure ? `The message must state ${input.check.keyFigure}.` : "",
    `Facts:\n${JSON.stringify(input.facts, null, 1)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  async function draft(state: typeof State.State) {
    const msgs = [new SystemMessage(SYSTEM), new HumanMessage(brief)];
    if (state.feedback) msgs.push(new HumanMessage(state.feedback));
    const { raw, parsed } = await model.invoke(msgs);
    const u = (raw as AIMessage).usage_metadata;
    const clean: Draft = {
      subject: input.channel === "email" ? parsed.subject.trim().slice(0, 160) : "",
      message: parsed.message.trim().slice(0, 4000),
      englishGist: input.language === "en" ? "" : parsed.englishGist.trim().slice(0, 4000),
    };
    return { draft: clean, attempts: 1, feedback: null, usage: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, total: u?.total_tokens ?? 0 } };
  }

  function check(state: typeof State.State) {
    const v = verifyMessage(state.draft!, { amountsPaise: amounts, keyFigurePaise: input.check.keyFigurePaise, keyFigure: input.check.keyFigure, language: input.language, channel: input.channel });
    if (v.ok || state.attempts >= 2) return { verification: v };
    return {
      verification: v,
      feedback: ["Your draft failed these checks:", ...v.checks.filter((c) => !c.ok).map((c) => `- ${c.name}: ${c.detail}`), "Rewrite it using only the facts given."].join("\n"),
    };
  }

  const final = await new StateGraph(State)
    .addNode("write", draft)
    .addNode("check", check)
    .addEdge(START, "write")
    .addEdge("write", "check")
    .addConditionalEdges("check", (s) => (s.feedback ? "write" : END), ["write", END])
    .compile()
    .invoke({}, { recursionLimit: 10 });

  return {
    ...final.draft!,
    verification: final.verification!,
    facts: input.facts,
    amountsPaise: input.amountsPaise,
    keyFigure: input.check.keyFigure,
    attempts: final.attempts,
    model: config.model,
    usage: final.usage,
    latencyMs: Date.now() - started,
  };
}
