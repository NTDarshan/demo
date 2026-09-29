// The daily brief's signals: things in the ledger that may need someone's attention today.
// Detected and scored in code (pure, unit tested). The AI only chooses the three that matter
// most and says why, in words; it cannot add a signal, a figure or a link that is not here.

import { addDays, formatDate, isoDateIST } from "@/lib/dates";
import { BUCKET_SHORT, type Bucket } from "@/lib/domain/reconcile";
import { MODE_LABEL, type PaymentMode, type PaymentStatus } from "@/lib/domain/payment-state";
import { formatINR } from "@/lib/money";

export type BriefInput = {
  today: string; // YYYY-MM-DD, IST
  now: string; // ISO timestamp
  students: { id: string; name: string; rollNo: string; balancePaise: number; overduePaise: number; oldestOverdueDate: string | null }[];
  installments: { studentId: string; label: string; dueDate: string; remainingPaise: number }[];
  payments: { id: string; studentId: string; amountPaise: number; mode: PaymentMode; status: PaymentStatus; createdAt: string; paidAt: string | null; reversedAt: string | null; reason: string | null }[];
  reconItems: { runId: string; bucket: Bucket; gatewayRef: string; filePaise: number | null; systemPaise: number | null; createdAt: string; hasSuggestion: boolean }[];
};

export type SignalKind = "pending_stuck" | "recon_open" | "newly_overdue" | "long_overdue" | "due_soon" | "collections_drop" | "collections_up" | "failures" | "advances";

export type SignalAction = { id: string; label: string; href: string };

export type Signal = {
  id: SignalKind;
  severity: number; // 0-100, higher needs attention sooner
  title: string; // factual, written by code
  facts: Record<string, string | number>;
  amountsPaise: number[];
  examples: { label: string; href: string; detail: string }[];
  actions: SignalAction[];
};

const inr = (p: number) => formatINR(p, { paise: "auto" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const hours = (fromIso: string, toIso: string) => (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function computeSignals(input: BriefInput): Signal[] {
  const { today, now } = input;
  const student = new Map(input.students.map((s) => [s.id, s]));
  const who = (id: string) => student.get(id);
  const out: Signal[] = [];

  // 1. Payments stuck in PENDING for more than a day: parents think they paid.
  const stuck = input.payments.filter((p) => p.status === "PENDING" && hours(p.createdAt, now) > 24).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (stuck.length) {
    const total = sum(stuck.map((p) => p.amountPaise));
    const oldestDays = Math.floor(hours(stuck[0]!.createdAt, now) / 24);
    out.push({
      id: "pending_stuck",
      severity: clamp(60 + stuck.length * 8 + Math.min(oldestDays, 10)),
      title: `${plural(stuck.length, "payment")} of ${inr(total)} stuck in pending for over a day`,
      facts: { count: stuck.length, total: inr(total), oldestDaysPending: oldestDays },
      amountsPaise: [total, ...stuck.map((p) => p.amountPaise)],
      examples: stuck.slice(0, 4).map((p) => ({ label: who(p.studentId)?.name ?? "Student", href: `/payments/${p.id}`, detail: `${inr(p.amountPaise)} ${MODE_LABEL[p.mode]}, since ${formatDate(p.createdAt)}` })),
      actions: [
        { id: "check_pending", label: "Check status with the gateway", href: "/payments?status=PENDING" },
        { id: "open_reconciliation", label: "Reconcile the latest settlement file", href: "/reconciliation" },
      ],
    });
  }

  // 2. Open reconciliation exceptions (each reference once, newest run first).
  const seen = new Set<string>();
  const open = [...input.reconItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((i) => (seen.has(`${i.bucket}:${i.gatewayRef}`) ? false : (seen.add(`${i.bucket}:${i.gatewayRef}`), true)));
  if (open.length) {
    const shortfall = sum(open.filter((i) => i.bucket === "AMOUNT_MISMATCH").map((i) => Math.max((i.systemPaise ?? 0) - (i.filePaise ?? 0), 0)));
    const missing = sum(open.filter((i) => i.bucket === "MISSING_IN_SETTLEMENT").map((i) => i.systemPaise ?? 0));
    const ready = open.filter((i) => i.hasSuggestion).length;
    const oldest = open.reduce((m, i) => (i.createdAt < m ? i.createdAt : m), open[0]!.createdAt);
    const age = days(isoDateIST(oldest), today);
    const runId = open[0]!.runId;
    out.push({
      id: "recon_open",
      severity: clamp(50 + open.length * 4 + (shortfall + missing > 0 ? 10 : 0) + Math.min(age, 10)),
      title: `${plural(open.length, "reconciliation exception")} open${age > 0 ? `, the oldest for ${plural(age, "day")}` : ""}`,
      facts: {
        open: open.length,
        byBucket: Object.entries(open.reduce<Record<string, number>>((m, i) => ((m[BUCKET_SHORT[i.bucket]] = (m[BUCKET_SHORT[i.bucket]] ?? 0) + 1), m), {}))
          .map(([k, v]) => `${k}: ${v}`)
          .join(", "),
        settledShortBy: inr(shortfall),
        recordedButNotSettled: inr(missing),
        copilotSuggestionsReady: ready,
        oldestDaysOpen: age,
      },
      amountsPaise: [shortfall, missing, ...open.flatMap((i) => [i.filePaise ?? 0, i.systemPaise ?? 0])],
      examples: open.slice(0, 4).map((i) => ({ label: i.gatewayRef, href: `/reconciliation/${i.runId}`, detail: BUCKET_SHORT[i.bucket] })),
      actions: [{ id: "review_exceptions", label: ready ? `Review ${plural(ready, "Copilot suggestion")}` : "Investigate with the Copilot", href: `/reconciliation/${runId}` }],
    });
  }

  // 3. Installments that became overdue in the last 7 days.
  const weekAgo = addDays(today, -7);
  const newlyDue = input.installments.filter((i) => i.remainingPaise > 0 && i.dueDate < today && i.dueDate >= weekAgo);
  if (newlyDue.length) {
    const total = sum(newlyDue.map((i) => i.remainingPaise));
    const ids = [...new Set(newlyDue.map((i) => i.studentId))];
    out.push({
      id: "newly_overdue",
      severity: clamp(45 + ids.length * 2),
      title: `${plural(ids.length, "student")} became overdue this week (${inr(total)})`,
      facts: { students: ids.length, total: inr(total), dueDates: [...new Set(newlyDue.map((i) => formatDate(i.dueDate)))].join(", ") },
      amountsPaise: [total],
      examples: ids.slice(0, 4).map((id) => ({ label: who(id)?.name ?? "Student", href: `/students/${who(id)?.rollNo ?? id}`, detail: inr(sum(newlyDue.filter((i) => i.studentId === id).map((i) => i.remainingPaise))) })),
      actions: [
        { id: "remind_parents", label: "Send overdue notices from the student pages", href: "/students?status=OVERDUE" },
      ],
    });
  }

  // 4. Students overdue for more than 30 days.
  const long = input.students.filter((s) => s.overduePaise > 0 && s.oldestOverdueDate && days(s.oldestOverdueDate, today) > 30).sort((a, b) => b.overduePaise - a.overduePaise);
  if (long.length) {
    const total = sum(long.map((s) => s.overduePaise));
    out.push({
      id: "long_overdue",
      severity: clamp(40 + long.length + Math.min(total / 10_000_000, 15)),
      title: `${plural(long.length, "student")} overdue for more than 30 days, ${inr(total)} in all`,
      facts: { students: long.length, total: inr(total), largest: `${long[0]!.name} ${inr(long[0]!.overduePaise)}` },
      amountsPaise: [total, ...long.slice(0, 5).map((s) => s.overduePaise)],
      examples: long.slice(0, 4).map((s) => ({ label: s.name, href: `/students/${s.rollNo}`, detail: `${inr(s.overduePaise)} since ${formatDate(s.oldestOverdueDate!)}` })),
      actions: [
        { id: "call_list", label: "Follow up with the parents, largest first", href: "/students?status=OVERDUE" },
        { id: "remind_parents", label: "Send overdue notices from the student pages", href: "/students?status=OVERDUE" },
      ],
    });
  }

  // 5. What falls due in the next 7 days: time for reminders.
  const soon = input.installments.filter((i) => i.remainingPaise > 0 && i.dueDate >= today && i.dueDate <= addDays(today, 7));
  if (soon.length) {
    const total = sum(soon.map((i) => i.remainingPaise));
    const ids = [...new Set(soon.map((i) => i.studentId))];
    out.push({
      id: "due_soon",
      severity: clamp(30 + Math.min(ids.length, 15)),
      title: `${inr(total)} falls due in the next 7 days, from ${plural(ids.length, "student")}`,
      facts: { students: ids.length, total: inr(total), dueDates: [...new Set(soon.map((i) => formatDate(i.dueDate)))].join(", ") },
      amountsPaise: [total],
      examples: ids.slice(0, 4).map((id) => ({ label: who(id)?.name ?? "Student", href: `/students/${who(id)?.rollNo ?? id}`, detail: inr(sum(soon.filter((i) => i.studentId === id).map((i) => i.remainingPaise))) })),
      actions: [{ id: "send_reminders", label: "Send upcoming-due reminders", href: "/students?status=DUE" }],
    });
  }

  // 6. Collections this week against the week before.
  const inWindow = (p: BriefInput["payments"][number], from: string, to: string) => p.status === "SUCCESS" && p.paidAt !== null && isoDateIST(p.paidAt) >= from && isoDateIST(p.paidAt) <= to;
  const thisWeek = sum(input.payments.filter((p) => inWindow(p, addDays(today, -6), today)).map((p) => p.amountPaise));
  const lastWeek = sum(input.payments.filter((p) => inWindow(p, addDays(today, -13), addDays(today, -7))).map((p) => p.amountPaise));
  if (lastWeek > 0 || thisWeek > 0) {
    const change = thisWeek - lastWeek;
    const pct = lastWeek ? Math.round((Math.abs(change) / lastWeek) * 100) : null;
    const drop = change < 0 && pct !== null && pct >= 30;
    out.push({
      id: drop ? "collections_drop" : "collections_up",
      severity: drop ? clamp(35 + pct! / 4) : 10,
      title: `${inr(thisWeek)} collected in the last 7 days, ${change >= 0 ? "up" : "down"} ${inr(Math.abs(change))}${pct !== null ? ` (${pct}%)` : ""} on the 7 days before`,
      facts: { last7Days: inr(thisWeek), previous7Days: inr(lastWeek), change: `${change >= 0 ? "+" : "−"}${inr(Math.abs(change))}`, changePercent: pct === null ? "n/a" : `${change >= 0 ? "+" : "−"}${pct}%` },
      amountsPaise: [thisWeek, lastWeek, Math.abs(change)],
      examples: [],
      actions: [{ id: "ask_collections", label: "Ask Kosha for the breakdown by mode", href: "/" }],
    });
  }

  // 7. Failed or reversed payments in the last 7 days.
  const bad = input.payments.filter((p) => (p.status === "FAILED" && isoDateIST(p.createdAt) >= weekAgo) || (p.status === "REVERSED" && p.reversedAt && isoDateIST(p.reversedAt) >= weekAgo));
  if (bad.length) {
    const total = sum(bad.map((p) => p.amountPaise));
    const byMode = bad.reduce<Record<string, number>>((m, p) => ((m[MODE_LABEL[p.mode]] = (m[MODE_LABEL[p.mode]] ?? 0) + 1), m), {});
    out.push({
      id: "failures",
      severity: clamp(25 + bad.length * 8),
      title: `${plural(bad.length, "payment")} failed or reversed this week (${inr(total)})`,
      facts: { count: bad.length, total: inr(total), byMode: Object.entries(byMode).map(([k, v]) => `${k}: ${v}`).join(", ") },
      amountsPaise: [total, ...bad.map((p) => p.amountPaise)],
      examples: bad.slice(0, 4).map((p) => ({ label: who(p.studentId)?.name ?? "Student", href: `/payments/${p.id}`, detail: `${inr(p.amountPaise)} ${p.status.toLowerCase()}${p.reason ? `: ${p.reason}` : ""}` })),
      actions: [{ id: "contact_payers", label: "Ask the parents to pay again", href: "/payments?status=FAILED" }],
    });
  }

  // 8. Money held as advance.
  const adv = input.students.filter((s) => s.balancePaise < 0);
  if (adv.length) {
    const total = sum(adv.map((s) => -s.balancePaise));
    out.push({
      id: "advances",
      severity: 12,
      title: `${inr(total)} held as advance for ${plural(adv.length, "student")}`,
      facts: { students: adv.length, total: inr(total) },
      amountsPaise: [total, ...adv.map((s) => -s.balancePaise)],
      examples: adv.slice(0, 4).map((s) => ({ label: s.name, href: `/students/${s.rollNo}`, detail: inr(-s.balancePaise) })),
      actions: [{ id: "review_advances", label: "Confirm it will be adjusted against next term", href: "/students?status=ADVANCE" }],
    });
  }

  return out.sort((a, b) => b.severity - a.severity);
}

/** Changes whenever the numbers behind the signals change, so a saved brief can say it is out of date. */
export function signalsFingerprint(signals: Signal[]): string {
  const text = signals.map((s) => `${s.id}:${s.title}`).join("|");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
