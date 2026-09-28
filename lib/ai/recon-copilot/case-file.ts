// The case the Copilot works on: one reconciliation exception, loaded straight from the
// database, plus the evidence bag that records every fact the agent's tools return.

import { ApiError } from "@/lib/api/errors";
import { db, runSingle } from "@/lib/data/db";
import { BUCKET_LABEL, type Bucket, type RejectedRow } from "@/lib/domain/reconcile";
import type { PaymentMode, PaymentStatus } from "@/lib/domain/payment-state";
import { EvidenceBag, inr, when } from "@/lib/ai/evidence";

export type CaseFile = {
  itemId: string;
  runId: string;
  runFileName: string;
  window: { from: string; to: string } | null;
  bucket: Bucket;
  gatewayRef: string;
  fileAmountPaise: number | null;
  fileStatus: string | null;
  settledAt: string | null;
  systemAmountPaise: number | null;
  paymentId: string | null;
  paymentStatusNow: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  paymentCreatedAt: string | null;
  paidAt: string | null;
  student: { id: string; name: string; rollNo: string } | null;
  /** file minus recorded, for amount mismatches */
  differencePaise: number | null;
  rejectedRows: RejectedRow[];
};

type ItemRow = {
  id: string;
  run_id: string;
  bucket: Bucket;
  gateway_ref: string;
  file_amount_paise: number | null;
  file_status: string | null;
  settled_at: string | null;
  system_amount_paise: number | null;
  payment_id: string | null;
  resolution: string | null;
  resolved_by: string | null;
  payments: { status: PaymentStatus; mode: PaymentMode; created_at: string; paid_at: string | null; students: { id: string; name: string; roll_no: string } | null } | null;
  reconciliation_runs: { file_name: string; totals: { window?: { from: string; to: string } | null }; rejected_rows: RejectedRow[] | null } | null;
};

export async function loadCaseFile(itemId: string): Promise<CaseFile> {
  const r = await runSingle<ItemRow>(
    db()
      .from("reconciliation_items")
      .select("*, payments(status, mode, created_at, paid_at, students(id, name, roll_no)), reconciliation_runs(file_name, totals, rejected_rows)")
      .eq("id", itemId)
      .maybeSingle(),
    "Reconciliation item not found.",
  );
  if (r.bucket === "MATCHED") throw new ApiError(409, "recon_item_matched", "Matched items need no investigation.");
  if (r.resolution) throw new ApiError(409, "recon_item_already_resolved", `This item was already resolved by ${r.resolved_by}.`);
  const file = r.file_amount_paise === null ? null : Number(r.file_amount_paise);
  const system = r.system_amount_paise === null ? null : Number(r.system_amount_paise);
  return {
    itemId: r.id,
    runId: r.run_id,
    runFileName: r.reconciliation_runs?.file_name ?? "settlement file",
    window: r.reconciliation_runs?.totals?.window ?? null,
    bucket: r.bucket,
    gatewayRef: r.gateway_ref,
    fileAmountPaise: file,
    fileStatus: r.file_status,
    settledAt: r.settled_at,
    systemAmountPaise: system,
    paymentId: r.payment_id,
    paymentStatusNow: r.payments?.status ?? null,
    paymentMode: r.payments?.mode ?? null,
    paymentCreatedAt: r.payments?.created_at ?? null,
    paidAt: r.payments?.paid_at ?? null,
    student: r.payments?.students ? { id: r.payments.students.id, name: r.payments.students.name, rollNo: r.payments.students.roll_no } : null,
    differencePaise: file !== null && system !== null ? file - system : null,
    rejectedRows: r.reconciliation_runs?.rejected_rows ?? [],
  };
}

export { EvidenceBag, inr, when, type EvidenceItem, type EvidenceKind } from "@/lib/ai/evidence";

/** The case as the model first sees it. Registers the item itself as evidence. */
export function caseBrief(c: CaseFile, bag: EvidenceBag): string {
  const itemId = bag.add(
    { id: `item:${c.gatewayRef}`, kind: "item", label: `${BUCKET_LABEL[c.bucket]} · ${c.gatewayRef}`, href: `/reconciliation/${c.runId}` },
    [c.fileAmountPaise, c.systemAmountPaise, c.differencePaise],
  );
  const facts = {
    evidenceId: itemId,
    bucket: c.bucket,
    bucketMeaning: BUCKET_LABEL[c.bucket],
    gatewayRef: c.gatewayRef,
    settlementFile: c.runFileName,
    fileCoversPaymentsMade: c.window ? `${c.window.from} to ${c.window.to} (settlements are T+1)` : null,
    inFile: c.fileAmountPaise === null ? "not in the file" : { amount: inr(c.fileAmountPaise), status: c.fileStatus, settledAt: when(c.settledAt) },
    recordedHere: { amount: inr(c.systemAmountPaise), paymentStatusNow: c.paymentStatusNow, mode: c.paymentMode, createdAt: when(c.paymentCreatedAt), paidAt: when(c.paidAt) },
    difference: c.differencePaise === null ? null : `${c.differencePaise > 0 ? "file is higher by" : "file is lower by"} ${inr(Math.abs(c.differencePaise))}`,
    paymentId: c.paymentId,
    student: c.student ? { studentId: c.student.id, name: c.student.name, rollNo: c.student.rollNo } : null,
  };
  return `Investigate this reconciliation exception.\n\n${JSON.stringify(facts, null, 2)}`;
}
