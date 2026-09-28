// The facts a message to a parent may contain, taken from the student's ledger in code.
// Pure and unit tested. The model only turns these into words: every amount it writes must
// be one of `amountsPaise`, and the purpose's key figure must appear.

import type { StudentDetail } from "@/lib/data/students";
import { formatDate } from "@/lib/dates";
import { MODE_LABEL } from "@/lib/domain/payment-state";
import { formatINR } from "@/lib/money";

export const PURPOSES = ["REMINDER", "OVERDUE", "BALANCE", "THANK_YOU"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const LANGUAGES = ["en", "kn", "hi"] as const;
export type Language = (typeof LANGUAGES)[number];
export const CHANNELS = ["whatsapp", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PURPOSE_LABEL: Record<Purpose, string> = {
  REMINDER: "Upcoming due",
  OVERDUE: "Overdue notice",
  BALANCE: "Balance explained",
  THANK_YOU: "Payment received",
};
export const LANGUAGE_LABEL: Record<Language, string> = { en: "English", kn: "ಕನ್ನಡ Kannada", hi: "हिन्दी Hindi" };
export const LANGUAGE_NAME: Record<Language, string> = { en: "English", kn: "Kannada", hi: "Hindi" };

const inr = (p: number) => formatINR(p, { paise: "auto" });

export type MessageFacts = {
  college: string;
  office: string;
  student: { name: string; rollNo: string; course: string; year: number };
  today: string;
  totals: { totalFees: string; concessions: string | null; paid: string; outstanding: string | null; advance: string | null; overdue: string | null };
  overdueInstallments: { installment: string; dueDate: string; remaining: string }[];
  oldestOverdueDate: string | null;
  daysOverdue: number | null;
  nextDue: { date: string; amount: string; installments: string[] } | null;
  lastPayment: { amount: string; date: string; mode: string; receiptNo: string | null; allocatedTo: string[] } | null;
  pendingPayments: { amount: string; date: string; reference: string | null }[];
  howToPay: string;
};

export type PurposeCheck = { available: boolean; reason: string | null; keyFigurePaise: number | null; keyFigure: string | null };

export function buildFacts(detail: StudentDetail, today: string): { facts: MessageFacts; amountsPaise: number[]; purposes: Record<Purpose, PurposeCheck> } {
  const b = detail.balance;
  const amounts = new Set<number>();
  const add = (p: number) => {
    amounts.add(Math.abs(p));
    return inr(Math.abs(p));
  };

  const overdue = detail.installments.filter((i) => i.status === "OVERDUE" && i.remainingPaise > 0);
  const upcoming = detail.installments.filter((i) => i.remainingPaise > 0 && i.status !== "OVERDUE" && i.dueDate >= today).sort((x, y) => x.dueDate.localeCompare(y.dueDate));
  const nextDate = upcoming[0]?.dueDate ?? null;
  const nextItems = nextDate ? upcoming.filter((i) => i.dueDate === nextDate) : [];
  const nextAmount = nextItems.reduce((s, i) => s + i.remainingPaise, 0);
  const last = detail.payments.find((p) => p.status === "SUCCESS") ?? null;
  const pending = detail.payments.filter((p) => p.status === "PENDING");
  const daysOverdue = b.oldestOverdueDate ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${b.oldestOverdueDate}T00:00:00Z`)) / 86_400_000) : null;

  const facts: MessageFacts = {
    college: "Nandi Hills College",
    office: "Accounts Office",
    student: { name: detail.student.name, rollNo: detail.student.rollNo, course: detail.student.courseName, year: detail.student.year },
    today: formatDate(today),
    totals: {
      totalFees: add(b.totalDemandPaise),
      concessions: b.totalConcessionPaise ? add(b.totalConcessionPaise) : null,
      paid: add(b.totalPaidPaise),
      outstanding: b.balancePaise > 0 ? add(b.balancePaise) : null,
      advance: b.balancePaise < 0 ? add(-b.balancePaise) : null,
      overdue: b.overduePaise > 0 ? add(b.overduePaise) : null,
    },
    overdueInstallments: overdue.map((i) => ({ installment: i.label, dueDate: formatDate(i.dueDate), remaining: add(i.remainingPaise) })),
    oldestOverdueDate: b.oldestOverdueDate ? formatDate(b.oldestOverdueDate) : null,
    daysOverdue,
    nextDue: nextDate ? { date: formatDate(nextDate), amount: add(nextAmount), installments: nextItems.map((i) => `${i.label} ${add(i.remainingPaise)}`) } : null,
    lastPayment: last
      ? { amount: add(last.amountPaise), date: formatDate(last.paidAt ?? last.createdAt), mode: MODE_LABEL[last.mode], receiptNo: last.receiptNo, allocatedTo: last.allocations.map((a) => `${a.label} ${add(a.amountPaise)}`) }
      : null,
    pendingPayments: pending.map((p) => ({ amount: add(p.amountPaise), date: formatDate(p.createdAt), reference: p.gatewayRef })),
    howToPay: "Pay at the college accounts counter (cash, card or UPI), or online by UPI or card from the student portal. Quote the roll number.",
  };

  const purposes: Record<Purpose, PurposeCheck> = {
    REMINDER: nextDate
      ? { available: true, reason: null, keyFigurePaise: nextAmount, keyFigure: inr(nextAmount) }
      : { available: false, reason: "Nothing falls due after today.", keyFigurePaise: null, keyFigure: null },
    OVERDUE: b.overduePaise > 0
      ? { available: true, reason: null, keyFigurePaise: b.overduePaise, keyFigure: inr(b.overduePaise) }
      : { available: false, reason: "Nothing is overdue.", keyFigurePaise: null, keyFigure: null },
    BALANCE: { available: true, reason: null, keyFigurePaise: Math.abs(b.balancePaise) || null, keyFigure: b.balancePaise ? inr(Math.abs(b.balancePaise)) : null },
    THANK_YOU: last
      ? { available: true, reason: null, keyFigurePaise: last.amountPaise, keyFigure: inr(last.amountPaise) }
      : { available: false, reason: "No successful payment yet.", keyFigurePaise: null, keyFigure: null },
  };

  return { facts, amountsPaise: [...amounts], purposes };
}
