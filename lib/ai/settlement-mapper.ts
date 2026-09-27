// Smart settlement import: the AI proposes how an unfamiliar settlement file's columns map to
// Kosha's four (gateway_ref, amount_inr, status, settled_at). A small LangGraph loop:
//
//   START → propose → check ─(too many sample rows fail, first try)→ propose (with failures) → END
//
// "check" runs the real conversion code (lib/domain/settlement-mapping.ts) on the sample rows.
// Only column names and a sample of rows are sent to the model, never the whole file, and the
// accountant confirms (and can edit) the mapping before anything is reconciled.

import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { aiConfig, chatModel } from "@/lib/ai/config";
import { applyMapping, DATE_FORMATS, parseDateAs, profileColumns, STATUS_TARGETS, unknownColumns, type ColumnMapping, type MappingStats } from "@/lib/domain/settlement-mapping";

export const mappingSchema = z.object({
  gatewayRef: z.object({ column: z.string(), reason: z.string().describe("One short sentence.") }),
  amount: z.object({
    column: z.string(),
    unit: z.enum(["rupees", "paise"]),
    reason: z.string(),
  }),
  status: z.object({
    column: z.string().describe("Empty string if the file has no status column (then every row is treated as settled)."),
    values: z.array(z.object({ from: z.string().describe("A status value exactly as it appears in the file."), to: z.enum(STATUS_TARGETS) })),
    reason: z.string(),
  }),
  settledAt: z.object({
    column: z.string(),
    format: z
      .enum(DATE_FORMATS)
      .describe("ISO = year first with dashes: 2026-09-22 or 2026-09-22T11:00:00+05:30. YYYY/MM/DD = year first with slashes: 2026/09/22. DD/MM/YYYY = 22/09/2026. MM/DD/YYYY = 09/22/2026. DD-MMM-YYYY = 22-Sep-2026. Times after the date are allowed in every format."),
    reason: z.string(),
  }),
  notes: z.array(z.string()).describe("0 to 3 things the accountant should know, e.g. which columns were ignored and why."),
  confidence: z.enum(["high", "medium", "low"]),
});
export type MappingProposal = z.infer<typeof mappingSchema>;

export type MappingResult = {
  mapping: ColumnMapping;
  reasons: { gatewayRef: string; amount: string; status: string; settledAt: string };
  notes: string[];
  confidence: MappingProposal["confidence"];
  sampleStats: MappingStats;
  attempts: number;
  model: string;
  usage: { input: number; output: number; total: number };
  latencyMs: number;
};

const SYSTEM = `You map payment-gateway settlement reports to the format of Kosha, an Indian college's fee ledger.
Kosha needs four fields per row:
- gateway_ref: the gateway's transaction reference for the payment (in this college's data they look like MGW7300000012). Not the settlement batch id, UTR of the bank payout, or an internal row number.
- amount_inr: the GROSS amount the payer paid for that transaction. Never the net amount after MDR/fees/GST: Kosha matches what the parent paid, and fees are reconciled separately.
- status: the transaction's status. Map every distinct status value you see: captured/settled/success/paid -> SUCCESS; failed/declined -> FAILED; refunded/reversed/chargeback -> REFUNDED; anything that is not a settled payment (pending, initiated, cancelled) -> IGNORE.
- settled_at: when the gateway SETTLED the money to the college. Not the transaction or payment date. Pick the date format that fits every example (DD/MM/YYYY is the Indian default when the day is 12 or less and it is ambiguous; use the examples to decide).
Use column names exactly as given. Amounts are in rupees unless the column is clearly in paise (whole numbers 100x too large).`;

const State = Annotation.Root({
  proposal: Annotation<MappingProposal | null>({ reducer: (_, b) => b, default: () => null }),
  stats: Annotation<MappingStats | null>({ reducer: (_, b) => b, default: () => null }),
  feedback: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  attempts: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  usage: Annotation<{ input: number; output: number; total: number }>({
    reducer: (a, b) => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total }),
    default: () => ({ input: 0, output: 0, total: 0 }),
  }),
});

export function toColumnMapping(p: MappingProposal): ColumnMapping {
  return {
    gatewayRef: { column: p.gatewayRef.column },
    amount: { column: p.amount.column, unit: p.amount.unit },
    status: { column: p.status.column, values: p.status.column ? p.status.values : [] },
    settledAt: { column: p.settledAt.column, format: p.settledAt.format },
  };
}

export async function proposeMapping(headers: string[], rows: Record<string, string | undefined>[]): Promise<MappingResult> {
  const config = aiConfig();
  if (!config) throw new ApiError(503, "ai_unavailable", "Smart import is off: OPENAI_API_KEY is not set on the server.");
  const started = Date.now();
  const model = chatModel(config).withStructuredOutput(mappingSchema, { name: "mapping", includeRaw: true });
  const profile = profileColumns(headers, rows);
  const brief = `File columns with example values (${rows.length} sample rows):\n${JSON.stringify(profile, null, 1)}`;

  async function propose(state: typeof State.State) {
    const msgs = [new SystemMessage(SYSTEM), new HumanMessage(brief)];
    if (state.feedback) msgs.push(new HumanMessage(state.feedback));
    const { raw, parsed } = await model.invoke(msgs);
    const u = (raw as AIMessage).usage_metadata;
    return { proposal: parsed, attempts: 1, feedback: null, usage: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, total: u?.total_tokens ?? 0 } };
  }

  function check(state: typeof State.State) {
    const p = state.proposal!;
    const mapping = toColumnMapping(p);
    const missing = unknownColumns(mapping, headers);
    const { stats, issues } = applyMapping(rows, mapping);
    const ok = missing.length === 0 && stats.converted >= Math.ceil(stats.rows * 0.9);
    if (ok || state.attempts >= 2) return { stats };
    const examples = issues.slice(0, 8).map((i) => `- ${i.field}: "${i.value}" ${i.problem}`);
    // Tell the model which date formats actually read the chosen column, computed by the parser.
    const dates = rows.map((r) => (r[mapping.settledAt.column] ?? "").trim()).filter(Boolean);
    const fitting = DATE_FORMATS.filter((f) => dates.length > 0 && dates.every((d) => parseDateAs(d, f) !== null));
    return {
      stats,
      feedback: [
        missing.length ? `These columns do not exist in the file: ${missing.join(", ")}. Use names exactly as listed.` : "",
        `Only ${stats.converted} of ${stats.rows} sample rows converted with your mapping. Problems:`,
        ...examples,
        stats.byField.settled_at ? `Date formats that read every value in "${mapping.settledAt.column}": ${fitting.join(", ") || "none (choose another column)"}.` : "",
        "Fix the mapping (a different column, date format, amount unit or status values).",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const graph = new StateGraph(State)
    .addNode("propose", propose)
    .addNode("check", check)
    .addEdge(START, "propose")
    .addEdge("propose", "check")
    .addConditionalEdges("check", (s) => (s.feedback ? "propose" : END), ["propose", END])
    .compile();

  const final = await graph.invoke({}, { recursionLimit: 10 });
  const p = final.proposal!;
  return {
    mapping: toColumnMapping(p),
    reasons: { gatewayRef: p.gatewayRef.reason, amount: p.amount.reason, status: p.status.reason, settledAt: p.settledAt.reason },
    notes: p.notes.slice(0, 3),
    confidence: final.stats && final.stats.converted < final.stats.rows ? "low" : p.confidence,
    sampleStats: final.stats!,
    attempts: final.attempts,
    model: config.model,
    usage: final.usage,
    latencyMs: Date.now() - started,
  };
}
