// Shapes shared by the server and the browser (types only).

import type { EvidenceItem } from "@/lib/ai/evidence";
import type { Answer } from "@/lib/ai/ask/schema";
import type { AnswerVerification } from "@/lib/ai/ask/verify";

export type AskTurn = { role: "user" | "assistant"; content: string };

export type AskResult = Answer & {
  evidence: EvidenceItem[];
  verification: AnswerVerification;
  lookups: { tool: string; label: string; summary: string | null }[];
  model: string;
  usage: { input: number; output: number; total: number };
  latencyMs: number;
};

export type AskEvent =
  | { type: "step"; id: string; label: string; state: "running" | "done" | "error"; detail?: string | null }
  | { type: "done"; result: AskResult }
  | { type: "error"; code: string; message: string };
