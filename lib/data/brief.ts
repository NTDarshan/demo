// Data for the daily brief: the ledger snapshot the signals are computed from, and the saved
// briefs (written through save_ai_brief()).

import type { Role } from "@/lib/auth/permissions";
import type { BriefContent } from "@/lib/ai/brief/brief";
import type { BriefInput } from "@/lib/ai/brief/signals";
import { db, rpc, run } from "@/lib/data/db";
import { toBalance } from "@/lib/data/students";
import { addDays, isoDateIST } from "@/lib/dates";
import type { Bucket } from "@/lib/domain/reconcile";
import type { PaymentMode, PaymentStatus } from "@/lib/domain/payment-state";

export async function loadBriefInput(now = new Date()): Promise<BriefInput> {
  const today = isoDateIST(now);
  const since = `${addDays(today, -21)}T00:00:00+05:30`;
  const client = db();
  const [balances, installments, recent, pending, items, suggestions] = await Promise.all([
    run<Parameters<typeof toBalance>[0][]>(client.from("v_student_balances").select("*")),
    run<{ student_id: string; label: string; due_date: string; remaining_paise: number }[]>(
      client.from("v_installment_status").select("student_id, label, due_date, remaining_paise").gt("remaining_paise", 0),
    ),
    run<{ id: string; student_id: string; amount_paise: number; mode: PaymentMode; status: PaymentStatus; created_at: string; paid_at: string | null; reversed_at: string | null; failure_reason: string | null; reversal_reason: string | null }[]>(
      client.from("payments").select("id, student_id, amount_paise, mode, status, created_at, paid_at, reversed_at, failure_reason, reversal_reason").or(`created_at.gte.${since},paid_at.gte.${since},reversed_at.gte.${since}`),
    ),
    run<{ id: string; student_id: string; amount_paise: number; mode: PaymentMode; status: PaymentStatus; created_at: string; paid_at: string | null; reversed_at: string | null; failure_reason: string | null; reversal_reason: string | null }[]>(
      client.from("payments").select("id, student_id, amount_paise, mode, status, created_at, paid_at, reversed_at, failure_reason, reversal_reason").eq("status", "PENDING"),
    ),
    run<{ id: string; run_id: string; bucket: Bucket; gateway_ref: string; file_amount_paise: number | null; system_amount_paise: number | null; created_at: string }[]>(
      client.from("reconciliation_items").select("id, run_id, bucket, gateway_ref, file_amount_paise, system_amount_paise, created_at").is("resolution", null).neq("bucket", "MATCHED"),
    ),
    run<{ recon_item_id: string }[]>(client.from("ai_investigations").select("recon_item_id").eq("status", "PROPOSED")),
  ]);
  const withSuggestion = new Set(suggestions.map((s) => s.recon_item_id));
  const payments = new Map([...recent, ...pending].map((p) => [p.id, p]));
  return {
    today,
    now: now.toISOString(),
    students: balances.map(toBalance).map((b) => ({ id: b.studentId, name: b.name, rollNo: b.rollNo, balancePaise: b.balancePaise, overduePaise: b.overduePaise, oldestOverdueDate: b.oldestOverdueDate })),
    installments: installments.map((i) => ({ studentId: i.student_id, label: i.label, dueDate: i.due_date, remainingPaise: Number(i.remaining_paise) })),
    payments: [...payments.values()].map((p) => ({
      id: p.id,
      studentId: p.student_id,
      amountPaise: Number(p.amount_paise),
      mode: p.mode,
      status: p.status,
      createdAt: p.created_at,
      paidAt: p.paid_at,
      reversedAt: p.reversed_at,
      reason: p.failure_reason ?? p.reversal_reason,
    })),
    reconItems: items.map((i) => ({
      runId: i.run_id,
      bucket: i.bucket,
      gatewayRef: i.gateway_ref,
      filePaise: i.file_amount_paise === null ? null : Number(i.file_amount_paise),
      systemPaise: i.system_amount_paise === null ? null : Number(i.system_amount_paise),
      createdAt: i.created_at,
      hasSuggestion: withSuggestion.has(i.id),
    })),
  };
}

export type SavedBrief = BriefContent & { id: string; createdAt: string; createdBy: string };

export async function latestBrief(date: string): Promise<SavedBrief | null> {
  const rows = await run<{ id: string; content: BriefContent; created_at: string; created_by: string }[]>(
    db().from("ai_briefs").select("id, content, created_at, created_by").eq("brief_date", date).order("created_at", { ascending: false }).limit(1),
  );
  const r = rows[0];
  return r ? { ...r.content, id: r.id, createdAt: r.created_at, createdBy: r.created_by } : null;
}

export async function saveBrief(actor: Role, content: BriefContent): Promise<SavedBrief> {
  const row = await rpc<{ id: string; content: BriefContent; created_at: string; created_by: string }>("save_ai_brief", { p_actor: actor, p_date: content.date, p_content: content });
  return { ...row.content, id: row.id, createdAt: row.created_at, createdBy: row.created_by };
}
