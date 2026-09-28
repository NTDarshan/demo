// Reads and writes for the Copilot's investigations. Writes go through SQL functions
// (save_ai_investigation, decide_ai_investigation), like every other write in Kosha.

import type { Role } from "@/lib/auth/permissions";
import { db, rpc, run } from "@/lib/data/db";
import type { EvidenceItem } from "@/lib/ai/recon-copilot/case-file";
import type { Diagnosis } from "@/lib/ai/recon-copilot/schema";
import type { Investigation, TraceStep } from "@/lib/ai/recon-copilot/types";
import type { Verification } from "@/lib/ai/recon-copilot/verify";

type Row = {
  id: string;
  recon_item_id: string;
  status: Investigation["status"];
  recommendation: Investigation["recommendation"];
  confidence: Investigation["confidence"];
  result: { diagnosis: Diagnosis; evidence: EvidenceItem[] };
  verification: Verification;
  trace: TraceStep[];
  model: string;
  usage: Investigation["usage"];
  latency_ms: number;
  created_by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
};

export function toInvestigation(r: Row): Investigation {
  return {
    id: r.id,
    reconItemId: r.recon_item_id,
    status: r.status,
    recommendation: r.recommendation,
    confidence: r.confidence,
    diagnosis: r.result.diagnosis,
    evidence: r.result.evidence ?? [],
    verification: r.verification,
    trace: r.trace ?? [],
    model: r.model,
    usage: r.usage ?? { input: 0, output: 0, total: 0 },
    latencyMs: r.latency_ms,
    createdBy: r.created_by,
    createdAt: r.created_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
  };
}

export async function saveInvestigation(input: {
  itemId: string;
  actor: Role;
  diagnosis: Diagnosis;
  evidence: EvidenceItem[];
  verification: Verification;
  trace: TraceStep[];
  model: string;
  usage: Investigation["usage"];
  latencyMs: number;
}): Promise<Investigation> {
  const row = await rpc<Row>("save_ai_investigation", {
    p_item_id: input.itemId,
    p_actor: input.actor,
    p_recommendation: input.diagnosis.recommendation.action,
    p_confidence: input.diagnosis.confidence,
    p_result: { diagnosis: input.diagnosis, evidence: input.evidence },
    p_verification: input.verification,
    p_trace: input.trace,
    p_model: input.model,
    p_usage: input.usage,
    p_latency_ms: input.latencyMs,
  });
  return toInvestigation(row);
}

/** Latest investigation per item for a run (superseded ones are skipped). */
export async function latestInvestigationsForRun(runId: string): Promise<Record<string, Investigation>> {
  const items = await run<{ id: string }[]>(db().from("reconciliation_items").select("id").eq("run_id", runId).neq("bucket", "MATCHED"));
  if (items.length === 0) return {};
  const rows = await run<Row[]>(
    db()
      .from("ai_investigations")
      .select("*")
      .in("recon_item_id", items.map((i) => i.id))
      .neq("status", "SUPERSEDED")
      .order("created_at", { ascending: false }),
  );
  const out: Record<string, Investigation> = {};
  for (const r of rows) if (!out[r.recon_item_id]) out[r.recon_item_id] = toInvestigation(r);
  return out;
}

export async function decideInvestigation(id: string, decision: "ACCEPT" | "DISMISS", actor: Role, note: string | null) {
  const res = await rpc<{ investigation: Row; resolved: unknown }>("decide_ai_investigation", {
    p_investigation_id: id,
    p_decision: decision,
    p_actor: actor,
    p_note: note,
  });
  return { investigation: toInvestigation(res.investigation), resolved: res.resolved };
}
