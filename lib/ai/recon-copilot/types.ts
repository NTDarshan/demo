// Shapes shared by the server and the browser. Types only: importing this file never pulls
// server code (or the OpenAI key) into the client bundle.

import type { Confidence, CopilotAction, Diagnosis } from "@/lib/ai/recon-copilot/schema";
import type { Verification } from "@/lib/ai/recon-copilot/verify";
import type { EvidenceItem } from "@/lib/ai/recon-copilot/case-file";

export type InvestigationStatus = "PROPOSED" | "ACCEPTED" | "DISMISSED" | "SUPERSEDED";

export type TraceStep = { tool: string; label: string; args: Record<string, unknown>; summary: string | null; error: boolean };

export type Investigation = {
  id: string;
  reconItemId: string;
  status: InvestigationStatus;
  recommendation: CopilotAction;
  confidence: Confidence;
  diagnosis: Diagnosis;
  evidence: EvidenceItem[];
  verification: Verification;
  trace: TraceStep[];
  model: string;
  usage: { input: number; output: number; total: number };
  latencyMs: number;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

/** One line of the streamed response from POST /api/ai/recon-items/:id/investigate (NDJSON). */
export type CopilotEvent =
  | { type: "step"; id: string; label: string; state: "running" | "done" | "error"; detail?: string | null }
  | { type: "done"; investigation: Investigation }
  | { type: "error"; code: string; message: string };
