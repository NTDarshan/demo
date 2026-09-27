// The Copilot's tools. Each one is a read-only database lookup: none of them can change a
// payment, the ledger or a reconciliation item. Every result carries evidence ids that the
// diagnosis must cite, and every amount it returns is registered in the evidence bag so the
// verifier can check the figures the model quotes.
//
// Each result also has a one-line `summary`, which the UI shows as the agent works.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { db, run } from "@/lib/data/db";
import { getPaymentDetail } from "@/lib/data/payments";
import { getStudentDetail } from "@/lib/data/students";
import { toPaise } from "@/lib/money";
import type { PaymentMode, PaymentStatus } from "@/lib/domain/payment-state";
import { inr, when, type CaseFile, type EvidenceBag } from "@/lib/ai/recon-copilot/case-file";
import { similarity } from "@/lib/ai/recon-copilot/match";

const out = (summary: string, body: Record<string, unknown>) => JSON.stringify({ summary, ...body });

/** Payment evidence id: prefer what a person would recognise (gateway ref, then receipt). */
function paymentEvidenceId(p: { id: string; gatewayRef: string | null; receiptNo: string | null }): string {
  return `payment:${p.gatewayRef ?? p.receiptNo ?? p.id.slice(0, 8)}`;
}

const daysBetween = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

export function makeTools(c: CaseFile, bag: EvidenceBag) {
  const getPaymentTimeline = tool(
    async ({ paymentId }) => {
      const d = await getPaymentDetail(paymentId);
      const id = bag.add(
        { id: paymentEvidenceId(d.payment), kind: "payment", label: `Payment ${d.payment.gatewayRef ?? d.payment.receiptNo ?? ""}`.trim(), href: `/payments/${d.payment.id}` },
        [d.payment.amountPaise, ...d.allocations.map((a) => a.amountPaise)],
      );
      return out(`Payment is ${d.payment.status.toLowerCase()}, ${d.events.length} status change${d.events.length === 1 ? "" : "s"} on record`, {
        evidenceId: id,
        payment: {
          amount: inr(d.payment.amountPaise),
          mode: d.payment.mode,
          status: d.payment.status,
          gatewayRef: d.payment.gatewayRef,
          receiptNo: d.payment.receiptNo,
          createdAt: when(d.payment.createdAt),
          paidAt: when(d.payment.paidAt),
          failureReason: d.payment.failureReason,
          reversalReason: d.payment.reversalReason,
        },
        statusHistory: d.events.map((e) => ({ at: when(e.createdAt), change: `${e.fromStatus ?? "new"} → ${e.toStatus}`, by: e.actor, note: e.note })),
        allocatedTo: d.allocations.map((a) => ({ installment: a.label, amount: inr(a.amountPaise) })),
      });
    },
    {
      name: "get_payment_timeline",
      description: "Our record of a payment: amount, mode, current status, receipt, and every status change with who made it and when.",
      schema: z.object({ paymentId: z.string().describe("The payment id (uuid).") }),
    },
  );

  const getGatewayRecord = tool(
    async ({ gatewayRef }) => {
      const ref = gatewayRef.trim().toUpperCase();
      const row = await run<{ gateway_ref: string; amount_paise: number; final_status: string; created_at: string } | null>(
        db().from("mock_gateway_txns").select("*").eq("gateway_ref", ref).maybeSingle(),
      );
      if (!row) return out(`The gateway has no transaction ${ref}`, { evidenceId: null, found: false, gatewayRef: ref });
      const amount = Number(row.amount_paise);
      const id = bag.add({ id: `gateway:${ref}`, kind: "gateway", label: `Gateway record ${ref}`, href: null }, [amount]);
      return out(`Gateway says ${row.final_status.toLowerCase()} for ${inr(amount)}`, {
        evidenceId: id,
        found: true,
        source: "The payment gateway's transaction status API (what the gateway itself says happened).",
        gatewayRef: ref,
        gatewayStatus: row.final_status,
        amount: inr(amount),
        initiatedAt: when(row.created_at),
      });
    },
    {
      name: "get_gateway_record",
      description: "Ask the payment gateway what happened to a transaction: its final status and the amount it captured.",
      schema: z.object({ gatewayRef: z.string().describe("Gateway reference, e.g. MGW7300000012.") }),
    },
  );

  const getStudentAccount = tool(
    async ({ studentId }) => {
      const s = await getStudentDetail(studentId);
      const id = bag.add({ id: `student:${s.student.rollNo}`, kind: "student", label: `${s.student.name} (${s.student.rollNo})`, href: `/students/${s.student.rollNo}` }, [
        s.balance.balancePaise,
        s.balance.overduePaise,
        s.balance.totalPaidPaise,
        s.balance.totalDemandPaise,
        s.balance.totalConcessionPaise,
        ...s.installments.map((i) => i.remainingPaise),
        ...s.installments.map((i) => i.demandPaise),
      ]);
      const payments = s.payments.slice(0, 10).map((p) => ({
        evidenceId: bag.add({ id: paymentEvidenceId(p), kind: "payment", label: `Payment ${p.gatewayRef ?? p.receiptNo ?? ""}`.trim(), href: `/payments/${p.id}` }, [p.amountPaise]),
        paymentId: p.id,
        amount: inr(p.amountPaise),
        mode: p.mode,
        status: p.status,
        createdAt: when(p.createdAt),
      }));
      const balanceText = s.balance.balancePaise < 0 ? `${inr(-s.balance.balancePaise)} in advance` : `${inr(s.balance.balancePaise)} outstanding`;
      return out(`${s.student.name}: ${balanceText}, ${s.payments.length} payment${s.payments.length === 1 ? "" : "s"}`, {
        evidenceId: id,
        student: { name: s.student.name, rollNo: s.student.rollNo, course: s.student.courseName, year: s.student.year },
        balance: {
          totalFees: inr(s.balance.totalDemandPaise),
          concessions: inr(s.balance.totalConcessionPaise),
          paid: inr(s.balance.totalPaidPaise),
          outstanding: inr(s.balance.balancePaise),
          overdue: inr(s.balance.overduePaise),
        },
        openInstallments: s.installments
          .filter((i) => i.remainingPaise > 0)
          .map((i) => ({ installment: i.label, due: i.dueDate, remaining: inr(i.remainingPaise), status: i.status })),
        recentPayments: payments,
      });
    },
    {
      name: "get_student_account",
      description: "The student's fee account: balance, overdue amount, open installments and their recent payments.",
      schema: z.object({ studentId: z.string().describe("The student id (uuid).") }),
    },
  );

  const checkDuplicatePayments = tool(
    async ({ studentId }) => {
      const rows = await run<{ id: string; amount_paise: number; mode: PaymentMode; status: PaymentStatus; gateway_ref: string | null; receipt_no: string | null; created_at: string }[]>(
        db().from("payments").select("id, amount_paise, mode, status, gateway_ref, receipt_no, created_at").eq("student_id", studentId).order("created_at"),
      );
      const anchor = c.paymentCreatedAt;
      const others = rows.filter((r) => r.id !== c.paymentId && r.status !== "FAILED");
      // Suspicious: the same amount paid any time after this payment got stuck (the parent may
      // have paid again, even days later at the counter), or up to 7 days before it.
      const candidates = others
        .map((r) => ({
          r,
          amount: Number(r.amount_paise),
          after: anchor ? r.created_at > anchor : false,
          days: anchor ? daysBetween(anchor, r.created_at) : Number.POSITIVE_INFINITY,
        }))
        .filter(({ amount, after, days }) => amount === c.systemAmountPaise && (after || days <= 7));
      if (candidates.some(({ r }) => r.status === "SUCCESS" || r.status === "PENDING")) bag.duplicateSuspected = true;
      const list = candidates.map(({ r, amount, after, days }) => ({
        evidenceId: bag.add({ id: paymentEvidenceId({ id: r.id, gatewayRef: r.gateway_ref, receiptNo: r.receipt_no }), kind: "payment", label: `Payment ${r.gateway_ref ?? r.receipt_no ?? ""}`.trim(), href: `/payments/${r.id}` }, [amount]),
        paymentId: r.id,
        amount: inr(amount),
        mode: r.mode,
        status: r.status,
        createdAt: when(r.created_at),
        when: `${Math.round(days * 10) / 10} days ${after ? "after" : "before"} this payment`,
      }));
      const checkId = bag.add({ id: "check:duplicates", kind: "check", label: "Duplicate payment check", href: c.student ? `/students/${c.student.rollNo}` : null }, [c.systemAmountPaise]);
      return out(list.length === 0 ? "No second payment of the same amount" : `Found ${list.length} other payment${list.length === 1 ? "" : "s"} of the same amount`, {
        evidenceId: checkId,
        comparedWith: { amount: inr(c.systemAmountPaise), createdAt: when(c.paymentCreatedAt) },
        possibleDuplicates: list,
        meaning:
          list.length === 0
            ? "Nothing suggests the parent paid this amount twice."
            : "The parent may have paid again after the first attempt looked stuck. If the gateway also settled the first one, the college has received this amount twice: marking it as paid would leave the extra as an advance that probably needs a refund. A person must decide.",
      });
    },
    {
      name: "check_duplicate_payments",
      description: "Look for another non-failed payment by the same student for the same amount, made after this one or up to 7 days before it, which would mean the money may have been paid twice.",
      schema: z.object({ studentId: z.string().describe("The student id (uuid).") }),
    },
  );

  const searchSettlementFile = tool(
    async ({ amountRupees, gatewayRef }) => {
      const wantPaise = amountRupees ? toPaise(String(amountRupees)) : null;
      const want = wantPaise?.ok ? wantPaise.paise : null;
      const ref = gatewayRef?.trim().toUpperCase() || null;
      const items = await run<{ gateway_ref: string; bucket: string; file_amount_paise: number | null; settled_at: string | null }[]>(
        db().from("reconciliation_items").select("gateway_ref, bucket, file_amount_paise, settled_at").eq("run_id", c.runId).not("file_amount_paise", "is", null),
      );
      type Hit = { evidenceId: string; where: string; gatewayRef: string | null; amount: string | null; settledAt: string | null; why: string };
      const hits: Hit[] = [];
      for (const i of items) {
        const amount = Number(i.file_amount_paise);
        if (i.gateway_ref === c.gatewayRef) continue; // the item itself
        const reasons = similarity(want, amount, ref, i.gateway_ref);
        if (!reasons) continue;
        hits.push({
          evidenceId: bag.add({ id: `file:${i.gateway_ref}`, kind: "file", label: `File row ${i.gateway_ref}`, href: `/reconciliation/${c.runId}` }, [amount]),
          where: `bucket ${i.bucket}`,
          gatewayRef: i.gateway_ref,
          amount: inr(amount),
          settledAt: when(i.settled_at),
          why: reasons,
        });
      }
      for (const r of c.rejectedRows) {
        const rawAmount = typeof r.raw?.amount_inr === "string" ? toPaise(r.raw.amount_inr) : null;
        const amount = rawAmount?.ok ? rawAmount.paise : null;
        const rowRef = r.gatewayRef?.toUpperCase() ?? null;
        const reasons = rowRef === ref && ref ? "same reference, but the row was set aside" : similarity(want, amount, ref, rowRef);
        if (!reasons) continue;
        hits.push({
          evidenceId: bag.add({ id: `file:line-${r.line}`, kind: "file", label: `File line ${r.line}`, href: `/reconciliation/${c.runId}` }, [amount]),
          where: `line ${r.line}, set aside (${r.kind}): ${r.reason}`,
          gatewayRef: rowRef,
          amount: inr(amount),
          settledAt: null,
          why: reasons,
        });
      }
      const searchId = bag.add({ id: "check:settlement-search", kind: "check", label: "Search of the settlement file", href: `/reconciliation/${c.runId}` });
      return out(hits.length === 0 ? "No similar row in this settlement file" : `${hits.length} similar row${hits.length === 1 ? "" : "s"} in this settlement file`, {
        evidenceId: searchId,
        searchedFor: { amount: want === null ? null : inr(want), gatewayRef: ref },
        note: "Rows with the same amount are common (many students pay the same fee), so a same-amount row alone does not prove anything. A same amount together with a near-identical reference is a strong sign of a typo.",
        rows: hits.sort((a, b) => Number(b.why.includes("typo")) - Number(a.why.includes("typo"))).slice(0, 8),
      });
    },
    {
      name: "search_settlement_file",
      description:
        "Search the uploaded settlement file (matched rows, exceptions and rows set aside) for rows with the same amount or a near-identical gateway reference. Use it to spot a reference typed wrongly, or money settled under another row.",
      schema: z.object({
        amountRupees: z.number().nullable().describe("Amount in rupees to look for, e.g. 42500. Null to skip."),
        gatewayRef: z.string().nullable().describe("Reference to compare against, e.g. MGW7300000012. Null to skip."),
      }),
    },
  );

  const findRefInOtherRuns = tool(
    async ({ gatewayRef }) => {
      const ref = gatewayRef.trim().toUpperCase();
      const [items, runs] = await Promise.all([
        run<{ run_id: string; bucket: string; file_amount_paise: number | null; settled_at: string | null }[]>(
          db().from("reconciliation_items").select("run_id, bucket, file_amount_paise, settled_at").eq("gateway_ref", ref).neq("run_id", c.runId),
        ),
        run<{ id: string; file_name: string; created_at: string }[]>(db().from("reconciliation_runs").select("id, file_name, created_at").neq("id", c.runId).order("created_at")),
      ]);
      const byId = new Map(runs.map((r) => [r.id, r]));
      const seen = items
        .filter((i) => i.file_amount_paise !== null)
        .map((i) => {
          const r = byId.get(i.run_id);
          const amount = Number(i.file_amount_paise);
          return {
            evidenceId: bag.add({ id: `run:${i.run_id.slice(0, 8)}`, kind: "run", label: `Run of ${r?.file_name ?? "another file"}`, href: `/reconciliation/${i.run_id}` }, [amount]),
            file: r?.file_name ?? null,
            uploadedAt: when(r?.created_at),
            bucket: i.bucket,
            amount: inr(amount),
            settledAt: when(i.settled_at),
          };
        });
      const runsId = bag.add({ id: "check:other-runs", kind: "check", label: "Search of other settlement files", href: "/reconciliation" });
      return out(seen.length === 0 ? `${ref} is not in any other settlement file (${runs.length} other run${runs.length === 1 ? "" : "s"} checked)` : `${ref} appears in ${seen.length} other settlement file${seen.length === 1 ? "" : "s"}`, {
        evidenceId: runsId,
        gatewayRef: ref,
        otherRunsChecked: runs.length,
        appearances: seen,
      });
    },
    {
      name: "find_ref_in_other_runs",
      description: "Check whether a gateway reference was settled in any other settlement file uploaded before or after this one.",
      schema: z.object({ gatewayRef: z.string().describe("Gateway reference, e.g. MGW7300000012.") }),
    },
  );

  return [getPaymentTimeline, getGatewayRecord, getStudentAccount, checkDuplicatePayments, searchSettlementFile, findRefInOtherRuns];
}

/** What the UI says while a tool runs. */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  const ref = typeof args.gatewayRef === "string" ? args.gatewayRef.toUpperCase() : null;
  switch (name) {
    case "get_payment_timeline":
      return "Reading the payment's status history";
    case "get_gateway_record":
      return `Asking the gateway about ${ref ?? "the transaction"}`;
    case "get_student_account":
      return "Opening the student's fee account";
    case "check_duplicate_payments":
      return "Checking for a second payment of the same amount";
    case "search_settlement_file": {
      const amount = typeof args.amountRupees === "number" ? `₹${args.amountRupees.toLocaleString("en-IN")}` : null;
      return `Searching the settlement file${amount ? ` for ${amount}` : ""}${ref ? `${amount ? " or" : " for"} refs like ${ref}` : ""}`;
    }
    case "find_ref_in_other_runs":
      return `Looking for ${ref ?? "the reference"} in other settlement files`;
    default:
      return name;
  }
}

