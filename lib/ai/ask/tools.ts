// Ask Kosha's tools: typed, read-only questions the agent can ask the database.
//
// There is no text-to-SQL. Each tool is a fixed query with validated parameters, so the model
// can only read what these functions return, cannot touch tables it should not see, and can
// never write. Totals, counts and comparisons are computed here in code, not by the model:
// language models are unreliable at arithmetic, and the verifier checks every rupee figure in
// the answer against what these tools returned.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { EvidenceBag, inr, when } from "@/lib/ai/evidence";
import { db, run } from "@/lib/data/db";
import { getStudentDetail, toBalance, type StudentBalance } from "@/lib/data/students";
import { addDays, formatDate, isoDateIST } from "@/lib/dates";
import { BUCKET_LABEL, type Bucket } from "@/lib/domain/reconcile";
import { MODE_LABEL, PAYMENT_MODES, PAYMENT_STATUSES, type PaymentMode, type PaymentStatus } from "@/lib/domain/payment-state";
import { toPaise } from "@/lib/money";

const out = (summary: string, body: Record<string, unknown>) => JSON.stringify({ summary, ...body });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const COURSES = ["CSE", "BCA", "BCOM"] as const;

function rupeesToPaise(r: number | null | undefined): number | null {
  if (r === null || r === undefined) return null;
  const parsed = toPaise(String(r));
  return parsed.ok ? parsed.paise : null;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

const studentHref = (roll: string) => `/students/${roll}`;
const paymentEvidence = (p: { id: string; gateway_ref: string | null; receipt_no: string | null }) => `payment:${p.gateway_ref ?? p.receipt_no ?? p.id.slice(0, 8)}`;

async function allBalances(): Promise<StudentBalance[]> {
  const rows = await run<Parameters<typeof toBalance>[0][]>(db().from("v_student_balances").select("*"));
  return rows.map(toBalance);
}

export function makeAskTools(bag: EvidenceBag, today: string) {
  const addStudent = (b: { rollNo: string; name: string }, amounts: number[]) =>
    bag.add({ id: `student:${b.rollNo}`, kind: "student", label: `${b.name} (${b.rollNo})`, href: studentHref(b.rollNo) }, amounts);

  // -------------------------------------------------------------------------
  const searchStudents = tool(
    async (a) => {
      const all = await allBalances();
      const minOut = rupeesToPaise(a.minOutstandingRupees);
      const minOver = rupeesToPaise(a.minOverdueRupees);
      const q = a.nameOrRoll?.trim().toLowerCase() || null;
      const matched = all
        .filter((b) => !q || b.name.toLowerCase().includes(q) || b.rollNo.toLowerCase().includes(q))
        .filter((b) => !a.course || b.courseCode === a.course)
        .filter((b) => !a.year || b.year === a.year)
        .filter((b) => !a.status || b.status === a.status)
        .filter((b) => minOut === null || b.balancePaise >= minOut)
        .filter((b) => minOver === null || b.overduePaise >= minOver)
        .filter((b) => a.overdueForMoreThanDays == null || (b.oldestOverdueDate !== null && daysBetween(b.oldestOverdueDate, today) > a.overdueForMoreThanDays))
        .filter((b) => a.hasPendingPayment == null || (b.pendingCount > 0) === a.hasPendingPayment);
      const sorters: Record<string, (x: StudentBalance, y: StudentBalance) => number> = {
        outstanding: (x, y) => y.balancePaise - x.balancePaise,
        overdue: (x, y) => y.overduePaise - x.overduePaise || (x.oldestOverdueDate ?? "").localeCompare(y.oldestOverdueDate ?? ""),
        longest_overdue: (x, y) => (x.oldestOverdueDate ?? "9999").localeCompare(y.oldestOverdueDate ?? "9999"),
        name: (x, y) => x.name.localeCompare(y.name),
      };
      matched.sort(sorters[a.sortBy] ?? sorters.outstanding);
      let limit = Math.min(Math.max(a.limit ?? 15, 1), 60);
      // Never cut a tie in half: "who owes the most" with three students on the same amount
      // must show all three.
      const rankValue = (b: StudentBalance) => (a.sortBy === "overdue" ? b.overduePaise : a.sortBy === "outstanding" ? b.balancePaise : null);
      const cut = matched[limit - 1];
      if (cut && rankValue(cut) !== null) {
        while (limit < Math.min(matched.length, 60) && rankValue(matched[limit]!) === rankValue(cut)) limit += 1;
      }
      const totals = {
        outstanding: matched.reduce((s, b) => s + Math.max(b.balancePaise, 0), 0),
        overdue: matched.reduce((s, b) => s + b.overduePaise, 0),
        advance: matched.reduce((s, b) => s + Math.max(-b.balancePaise, 0), 0),
      };
      bag.addAmount(totals.outstanding);
      bag.addAmount(totals.overdue);
      bag.addAmount(totals.advance);
      const students = matched.slice(0, limit).map((b) => ({
        evidenceId: addStudent(b, [b.balancePaise, b.overduePaise, b.totalPaidPaise, b.totalDemandPaise, b.nextDuePaise, b.totalConcessionPaise]),
        name: b.name,
        rollNo: b.rollNo,
        course: b.courseCode,
        year: b.year,
        status: b.status,
        outstanding: inr(Math.max(b.balancePaise, 0)),
        advance: b.balancePaise < 0 ? inr(-b.balancePaise) : null,
        overdue: inr(b.overduePaise),
        overdueSince: b.oldestOverdueDate ? formatDate(b.oldestOverdueDate) : null,
        daysOverdue: b.oldestOverdueDate ? daysBetween(b.oldestOverdueDate, today) : null,
        nextDue: b.nextDueDate ? { date: formatDate(b.nextDueDate), amount: inr(b.nextDuePaise) } : null,
        pendingPayments: b.pendingCount,
        lastPaid: b.lastPaidAt ? formatDate(b.lastPaidAt) : null,
      }));
      return out(`${plural(matched.length, "student")} matched${matched.length > limit ? `, showing ${limit}` : ""}`, {
        matchedCount: matched.length,
        shown: students.length,
        note: students.length > (a.limit ?? 15) ? "More rows than the limit are shown because they are tied on the sort value." : undefined,
        totalsForAllMatched: { outstanding: inr(totals.outstanding), overdue: inr(totals.overdue), advance: inr(totals.advance) },
        students,
      });
    },
    {
      name: "search_students",
      description:
        "Find students by name/roll, course, year, fee status, minimum outstanding or overdue amount, how long they have been overdue, or whether they have a pending payment. Returns each student's balance and the totals for everyone matched.",
      schema: z.object({
        nameOrRoll: z.string().nullable().describe("Part of a name or roll number, e.g. 'Rohan' or 'CSE24'. Null for any."),
        course: z.enum(COURSES).nullable().describe("CSE (B.Tech CSE), BCA or BCOM (B.Com). Null for all."),
        year: z.number().int().min(1).max(5).nullable().describe("Year of study, 1 to 5. Null for all."),
        status: z
          .enum(["OVERDUE", "DUE", "PAID", "ADVANCE"])
          .nullable()
          .describe(
            "Leave null unless the user names a status. OVERDUE: has unpaid dues past their due date. DUE: owes, but nothing is overdue yet. PAID: nothing owed. ADVANCE: paid more than owed. Both OVERDUE and DUE students owe money, so for 'who owes', 'owes the most' or 'outstanding', use null and sortBy outstanding.",
          ),
        minOutstandingRupees: z.number().nullable().describe("Only students owing at least this many rupees in total."),
        minOverdueRupees: z.number().nullable().describe("Only students with at least this many rupees overdue."),
        overdueForMoreThanDays: z.number().int().nullable().describe("Only students whose oldest overdue installment is more than this many days past due."),
        hasPendingPayment: z.boolean().nullable().describe("true: only students with a payment stuck in PENDING."),
        sortBy: z.enum(["outstanding", "overdue", "longest_overdue", "name"]).describe("Sort order."),
        limit: z.number().int().nullable().describe("How many to list, default 15, max 60."),
      }),
    },
  );

  // -------------------------------------------------------------------------
  const getStudentAccount = tool(
    async ({ nameOrRoll }) => {
      const q = nameOrRoll.trim();
      const all = await allBalances();
      const exact = all.find((b) => b.rollNo.toLowerCase() === q.toLowerCase());
      const matches = exact ? [exact] : all.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()) || b.rollNo.toLowerCase().includes(q.toLowerCase()));
      if (matches.length !== 1) {
        return out(matches.length === 0 ? `No student matches "${q}"` : `${matches.length} students match "${q}"`, {
          found: false,
          candidates: matches.slice(0, 8).map((b) => ({ evidenceId: addStudent(b, []), name: b.name, rollNo: b.rollNo, course: b.courseCode })),
        });
      }
      const s = await getStudentDetail(matches[0]!.studentId);
      const id = addStudent(s.student, [
        s.balance.balancePaise, s.balance.overduePaise, s.balance.totalPaidPaise, s.balance.totalDemandPaise, s.balance.totalConcessionPaise, s.balance.nextDuePaise,
        ...s.installments.flatMap((i) => [i.demandPaise, i.remainingPaise, i.paidPaise, i.concessionPaise]),
        ...s.feeHeads.flatMap((f) => [f.demandPaise, f.remainingPaise, f.paidPaise, f.overduePaise, f.concessionPaise]),
      ]);
      const payments = s.payments.map((p) => ({
        evidenceId: bag.add({ id: paymentEvidence({ id: p.id, gateway_ref: p.gatewayRef, receipt_no: p.receiptNo }), kind: "payment", label: `Payment ${p.receiptNo ?? p.gatewayRef ?? ""}`.trim(), href: `/payments/${p.id}` }, [p.amountPaise, ...p.allocations.map((x) => x.amountPaise)]),
        amount: inr(p.amountPaise),
        mode: MODE_LABEL[p.mode],
        status: p.status,
        receiptNo: p.receiptNo,
        date: formatDate(p.paidAt ?? p.createdAt),
        note: p.failureReason ?? p.reversalReason ?? null,
        allocatedTo: p.allocations.map((x) => `${x.label} ${inr(x.amountPaise)}`),
      }));
      return out(`${s.student.name}: ${s.balance.balancePaise < 0 ? `${inr(-s.balance.balancePaise)} advance` : `${inr(s.balance.balancePaise)} outstanding`}`, {
        found: true,
        evidenceId: id,
        student: { name: s.student.name, rollNo: s.student.rollNo, course: s.student.courseName, year: s.student.year, email: s.student.email, phone: s.student.phone },
        balance: {
          totalFees: inr(s.balance.totalDemandPaise),
          concessions: inr(s.balance.totalConcessionPaise),
          paid: inr(s.balance.totalPaidPaise),
          outstanding: inr(Math.max(s.balance.balancePaise, 0)),
          advance: s.balance.balancePaise < 0 ? inr(-s.balance.balancePaise) : null,
          overdue: inr(s.balance.overduePaise),
          status: s.balance.status,
        },
        byFeeHead: s.feeHeads.map((f) => ({ feeHead: f.feeHead, fees: inr(f.demandPaise), paid: inr(f.paidPaise), remaining: inr(f.remainingPaise), overdue: inr(f.overduePaise) })),
        installments: s.installments.map((i) => ({ installment: i.label, due: formatDate(i.dueDate), fees: inr(i.demandPaise), concession: i.concessionPaise ? inr(i.concessionPaise) : null, paid: inr(i.paidPaise), remaining: inr(i.remainingPaise), status: i.status })),
        payments,
      });
    },
    {
      name: "get_student_account",
      description: "One student's full fee account: totals, each installment with due date and status, fee heads, and every payment with where it was allocated.",
      schema: z.object({ nameOrRoll: z.string().describe("Roll number (best, e.g. CSE24-001) or name.") }),
    },
  );

  // -------------------------------------------------------------------------
  const collections = tool(
    async (a) => {
      if (a.from > a.to) return out("The start date is after the end date", { error: "from must be on or before to" });
      type Row = { id: string; amount_paise: number; mode: PaymentMode; paid_at: string; gateway_ref: string | null; receipt_no: string | null; students: { roll_no: string; name: string; year: number; courses: { code: string } } | null };
      const fetchWindow = async (from: string, to: string) => {
        let q = db()
          .from("payments")
          .select("id, amount_paise, mode, paid_at, gateway_ref, receipt_no, students(roll_no, name, year, courses(code))")
          .eq("status", "SUCCESS")
          .gte("paid_at", `${from}T00:00:00+05:30`)
          .lte("paid_at", `${to}T23:59:59.999+05:30`);
        if (a.mode) q = q.eq("mode", a.mode);
        const rows = await run<Row[]>(q);
        return a.course ? rows.filter((r) => r.students?.courses.code === a.course) : rows;
      };
      const rows = await fetchWindow(a.from, a.to);
      const total = rows.reduce((s, r) => s + Number(r.amount_paise), 0);

      const keyOf = (r: Row): string => {
        const d = isoDateIST(r.paid_at);
        switch (a.groupBy) {
          case "day": return d;
          case "week": {
            const dow = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
            return `week of ${formatDate(addDays(d, -dow))}`;
          }
          case "month": return d.slice(0, 7);
          case "mode": return MODE_LABEL[r.mode];
          case "course": return r.students?.courses.code ?? "unknown";
          case "year": return `Year ${r.students?.year ?? "?"}`;
          default: return "all";
        }
      };
      const groupRows = (rs: Row[]) => {
        const m = new Map<string, { amount: number; count: number }>();
        for (const r of rs) {
          const g = m.get(keyOf(r)) ?? { amount: 0, count: 0 };
          g.amount += Number(r.amount_paise);
          g.count += 1;
          m.set(keyOf(r), g);
        }
        return m;
      };
      const groups = groupRows(rows);
      const groupList = [...groups.entries()]
        .sort(([ka, va], [kb, vb]) => (["day", "month", "week"].includes(a.groupBy) ? ka.localeCompare(kb) : vb.amount - va.amount))
        .map(([key, g]) => {
          bag.addAmount(g.amount);
          return { group: key, amount: inr(g.amount), payments: g.count, shareOfTotal: total ? `${Math.round((g.amount / total) * 1000) / 10}%` : "0%" };
        });

      let comparison: Record<string, unknown> | null = null;
      if (a.compareFrom && a.compareTo) {
        const prev = await fetchWindow(a.compareFrom, a.compareTo);
        const prevTotal = prev.reduce((s, r) => s + Number(r.amount_paise), 0);
        const change = total - prevTotal;
        bag.addAmount(prevTotal);
        bag.addAmount(change);
        // Same grouping for the earlier period, so "by mode, compared with last week" has both
        // sides of every row. Only groups by category compare meaningfully (days differ).
        const comparable = ["mode", "course", "year"].includes(a.groupBy);
        const prevGroups = comparable ? groupRows(prev) : new Map<string, { amount: number; count: number }>();
        const keys = [...new Set([...groups.keys(), ...prevGroups.keys()])];
        const byGroup = keys.map((k) => {
          const now = groups.get(k) ?? { amount: 0, count: 0 };
          const before = prevGroups.get(k) ?? { amount: 0, count: 0 };
          const diff = now.amount - before.amount;
          [now.amount, before.amount, diff].forEach((x) => bag.addAmount(x));
          return { group: k, thisPeriod: inr(now.amount), thisPeriodPayments: now.count, previousPeriod: inr(before.amount), previousPeriodPayments: before.count, change: `${diff >= 0 ? "+" : "−"}${inr(Math.abs(diff))}` };
        });
        comparison = {
          previousPeriod: `${formatDate(a.compareFrom)} to ${formatDate(a.compareTo)}`,
          previousTotal: inr(prevTotal),
          previousPayments: prev.length,
          change: `${change >= 0 ? "up" : "down"} ${inr(Math.abs(change))}`,
          changePercent: prevTotal ? `${change >= 0 ? "+" : "−"}${Math.round((Math.abs(change) / prevTotal) * 1000) / 10}%` : "no collections in the previous period",
          ...(comparable ? { byGroup } : {}),
        };
      }
      const largest = [...rows].sort((x, y) => Number(y.amount_paise) - Number(x.amount_paise)).slice(0, 5).map((r) => ({
        evidenceId: bag.add({ id: paymentEvidence(r), kind: "payment", label: `Payment ${r.receipt_no ?? r.gateway_ref ?? ""}`.trim(), href: `/payments/${r.id}` }, [Number(r.amount_paise)]),
        student: r.students ? `${r.students.name} (${r.students.roll_no})` : null,
        amount: inr(Number(r.amount_paise)),
        mode: MODE_LABEL[r.mode],
        date: formatDate(r.paid_at),
      }));
      const reportId = bag.add({ id: `report:collections:${a.from}:${a.to}`, kind: "report", label: `Collections ${formatDate(a.from)} to ${formatDate(a.to)}`, href: "/payments?status=SUCCESS" }, [total, rows.length ? Math.round(total / rows.length) : 0]);
      return out(`${inr(total)} collected from ${plural(rows.length, "payment")}${comparison ? `, ${String(comparison.change)} on the previous period` : ""}`, {
        evidenceId: reportId,
        period: `${formatDate(a.from)} to ${formatDate(a.to)}`,
        filters: { mode: a.mode ? MODE_LABEL[a.mode] : "all modes", course: a.course ?? "all courses" },
        total: inr(total),
        payments: rows.length,
        averagePayment: rows.length ? inr(Math.round(total / rows.length)) : null,
        groups: a.groupBy === "none" ? [] : groupList,
        comparison,
        largestPayments: largest,
        note: "Counts successful payments by the date they succeeded. Reversed payments are excluded.",
      });
    },
    {
      name: "collections",
      description:
        "Money collected (successful payments) in a date range, optionally filtered by mode or course, grouped by day, week, month, mode, course or year of study, and optionally compared with another period (the tool computes the change).",
      schema: z.object({
        from: ISO_DATE.describe("Start date, YYYY-MM-DD, inclusive (IST)."),
        to: ISO_DATE.describe("End date, YYYY-MM-DD, inclusive (IST)."),
        groupBy: z.enum(["none", "day", "week", "month", "mode", "course", "year"]),
        mode: z.enum(PAYMENT_MODES).nullable().describe("CASH, UPI, CARD or BANK_TRANSFER. Null for all."),
        course: z.enum(COURSES).nullable(),
        compareFrom: ISO_DATE.nullable().describe("Start of a period to compare with, or null."),
        compareTo: ISO_DATE.nullable().describe("End of the comparison period, or null."),
      }),
    },
  );

  // -------------------------------------------------------------------------
  const listPayments = tool(
    async (a) => {
      let q = db()
        .from("payments")
        .select("id, amount_paise, mode, status, gateway_ref, receipt_no, failure_reason, reversal_reason, created_at, paid_at, students!inner(roll_no, name)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (a.status) q = q.eq("status", a.status);
      if (a.mode) q = q.eq("mode", a.mode);
      if (a.from) q = q.gte("created_at", `${a.from}T00:00:00+05:30`);
      if (a.to) q = q.lte("created_at", `${a.to}T23:59:59.999+05:30`);
      if (a.rollNo) q = q.eq("students.roll_no", a.rollNo.toUpperCase());
      const min = rupeesToPaise(a.minAmountRupees);
      if (min !== null) q = q.gte("amount_paise", min);
      const rows = await run<{ id: string; amount_paise: number; mode: PaymentMode; status: PaymentStatus; gateway_ref: string | null; receipt_no: string | null; failure_reason: string | null; reversal_reason: string | null; created_at: string; paid_at: string | null; students: { roll_no: string; name: string } }[]>(q);
      const total = rows.reduce((s, r) => s + Number(r.amount_paise), 0);
      bag.addAmount(total);
      const limit = Math.min(Math.max(a.limit ?? 15, 1), 50);
      const payments = rows.slice(0, limit).map((r) => {
        addStudent({ rollNo: r.students.roll_no, name: r.students.name }, []);
        return {
          evidenceId: bag.add({ id: paymentEvidence(r), kind: "payment", label: `Payment ${r.receipt_no ?? r.gateway_ref ?? ""}`.trim(), href: `/payments/${r.id}` }, [Number(r.amount_paise)]),
          student: `${r.students.name} (${r.students.roll_no})`,
          studentEvidenceId: `student:${r.students.roll_no}`,
          amount: inr(Number(r.amount_paise)),
          mode: MODE_LABEL[r.mode],
          status: r.status,
          receiptNo: r.receipt_no,
          gatewayRef: r.gateway_ref,
          created: when(r.created_at),
          reason: r.failure_reason ?? r.reversal_reason,
        };
      });
      return out(`${plural(rows.length, "payment")} found${rows.length > limit ? `, showing ${limit}` : ""}`, { matchedCount: rows.length, totalAmount: inr(total), payments });
    },
    {
      name: "list_payments",
      description: "List payments (any status: PENDING, SUCCESS, FAILED, REVERSED, INITIATED) by status, mode, date created, student or minimum amount, newest first, with the total amount of all matches.",
      schema: z.object({
        status: z.enum(PAYMENT_STATUSES).nullable(),
        mode: z.enum(PAYMENT_MODES).nullable(),
        from: ISO_DATE.nullable().describe("Created on or after, YYYY-MM-DD."),
        to: ISO_DATE.nullable().describe("Created on or before, YYYY-MM-DD."),
        rollNo: z.string().nullable().describe("Only this student's payments."),
        minAmountRupees: z.number().nullable(),
        limit: z.number().int().nullable().describe("How many to list, default 15, max 50."),
      }),
    },
  );

  // -------------------------------------------------------------------------
  const feeOverview = tool(
    async ({ course, dueWithinDays }) => {
      const [balances, installments] = await Promise.all([
        allBalances(),
        run<{ student_id: string; fee_head: string; due_date: string; demand_paise: number; concession_paise: number; paid_paise: number; remaining_paise: number; status: string }[]>(
          db().from("v_installment_status").select("student_id, fee_head, due_date, demand_paise, concession_paise, paid_paise, remaining_paise, status"),
        ),
      ]);
      const inCourse = balances.filter((b) => !course || b.courseCode === course);
      const ids = new Set(inCourse.map((b) => b.studentId));
      const inst = installments.filter((i) => ids.has(i.student_id));
      const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
      const t = {
        fees: sum(inCourse.map((b) => b.totalDemandPaise)),
        concessions: sum(inCourse.map((b) => b.totalConcessionPaise)),
        collected: sum(inCourse.map((b) => b.totalPaidPaise)),
        outstanding: sum(inCourse.map((b) => Math.max(b.balancePaise, 0))),
        overdue: sum(inCourse.map((b) => b.overduePaise)),
        advance: sum(inCourse.map((b) => Math.max(-b.balancePaise, 0))),
      };
      const net = t.fees - t.concessions;
      const horizon = addDays(today, Math.min(Math.max(dueWithinDays ?? 30, 1), 180));
      const upcoming = inst.filter((i) => Number(i.remaining_paise) > 0 && i.due_date >= today && i.due_date <= horizon);
      const upcomingTotal = sum(upcoming.map((i) => Number(i.remaining_paise)));
      const byHead = new Map<string, { fees: number; collected: number; remaining: number; overdue: number }>();
      for (const i of inst) {
        const h = byHead.get(i.fee_head) ?? { fees: 0, collected: 0, remaining: 0, overdue: 0 };
        h.fees += Number(i.demand_paise) - Number(i.concession_paise);
        h.collected += Number(i.paid_paise);
        h.remaining += Math.max(Number(i.remaining_paise), 0);
        if (i.status === "OVERDUE") h.overdue += Number(i.remaining_paise);
        byHead.set(i.fee_head, h);
      }
      const byCourse = COURSES.filter((c) => !course || c === course).map((c) => {
        const bs = balances.filter((b) => b.courseCode === c);
        const r = {
          course: c,
          students: bs.length,
          fees: sum(bs.map((b) => b.totalDemandPaise - b.totalConcessionPaise)),
          collected: sum(bs.map((b) => b.totalPaidPaise)),
          outstanding: sum(bs.map((b) => Math.max(b.balancePaise, 0))),
          overdue: sum(bs.map((b) => b.overduePaise)),
          overdueStudents: bs.filter((b) => b.overduePaise > 0).length,
        };
        [r.fees, r.collected, r.outstanding, r.overdue].forEach((x) => bag.addAmount(x));
        return { ...r, fees: inr(r.fees), collected: inr(r.collected), outstanding: inr(r.outstanding), overdue: inr(r.overdue), collectionRate: r.fees ? `${Math.round((r.collected / r.fees) * 1000) / 10}%` : null };
      });
      const id = bag.add({ id: `report:fee-overview${course ? `:${course}` : ""}`, kind: "report", label: `Fee overview${course ? ` (${course})` : ""}`, href: "/" }, [
        ...Object.values(t), net, upcomingTotal, ...[...byHead.values()].flatMap((h) => [h.fees, h.collected, h.remaining, h.overdue]),
      ]);
      return out(`${inr(t.collected)} collected of ${inr(net)} due; ${inr(t.overdue)} overdue`, {
        evidenceId: id,
        asOf: formatDate(today),
        scope: course ?? "all courses",
        students: inCourse.length,
        totals: {
          feesCharged: inr(t.fees),
          concessions: inr(t.concessions),
          netFees: inr(net),
          collected: inr(t.collected),
          collectionRate: net ? `${Math.round((t.collected / net) * 1000) / 10}%` : null,
          outstanding: inr(t.outstanding),
          overdue: inr(t.overdue),
          heldAsAdvance: inr(t.advance),
        },
        studentsByStatus: Object.fromEntries(["OVERDUE", "DUE", "PAID", "ADVANCE"].map((s) => [s, inCourse.filter((b) => b.status === s).length])),
        byCourse,
        byFeeHead: [...byHead.entries()].map(([head, h]) => ({ feeHead: head, netFees: inr(h.fees), collected: inr(h.collected), remaining: inr(h.remaining), overdue: inr(h.overdue) })),
        dueSoon: { window: `${formatDate(today)} to ${formatDate(horizon)}`, installments: upcoming.length, students: new Set(upcoming.map((i) => i.student_id)).size, amount: inr(upcomingTotal) },
      });
    },
    {
      name: "fee_overview",
      description: "College-wide (or one course's) fee position today: fees charged, concessions, collected, collection rate, outstanding, overdue, advance, a breakdown by course and fee head, and what falls due in the next N days.",
      schema: z.object({
        course: z.enum(COURSES).nullable(),
        dueWithinDays: z.number().int().nullable().describe("Window for 'falls due soon', default 30 days."),
      }),
    },
  );

  // -------------------------------------------------------------------------
  const reconciliationOverview = tool(
    async () => {
      const [runs, items] = await Promise.all([
        run<{ id: string; file_name: string; created_at: string; row_count: number }[]>(db().from("reconciliation_runs").select("id, file_name, created_at, row_count").order("created_at", { ascending: false }).limit(10)),
        run<{ id: string; run_id: string; bucket: Bucket; gateway_ref: string; file_amount_paise: number | null; system_amount_paise: number | null; resolution: string | null; payments: { students: { name: string; roll_no: string } | null } | null }[]>(
          db().from("reconciliation_items").select("id, run_id, bucket, gateway_ref, file_amount_paise, system_amount_paise, resolution, payments(students(name, roll_no))").neq("bucket", "MATCHED"),
        ),
      ]);
      const open = items.filter((i) => !i.resolution);
      const runIds = new Set(runs.map((r) => r.id));
      const openList = open.filter((i) => runIds.has(i.run_id)).map((i) => {
        const amounts = [i.file_amount_paise, i.system_amount_paise].map((x) => (x === null ? null : Number(x)));
        return {
          evidenceId: bag.add({ id: `item:${i.gateway_ref}`, kind: "item", label: `${BUCKET_LABEL[i.bucket]} · ${i.gateway_ref}`, href: `/reconciliation/${i.run_id}` }, amounts),
          bucket: BUCKET_LABEL[i.bucket],
          gatewayRef: i.gateway_ref,
          student: i.payments?.students ? `${i.payments.students.name} (${i.payments.students.roll_no})` : null,
          inFile: inr(amounts[0]),
          recordedHere: inr(amounts[1]),
        };
      });
      const id = bag.add({ id: "report:reconciliation", kind: "report", label: "Reconciliation runs", href: "/reconciliation" });
      return out(`${plural(runs.length, "settlement file")} reconciled, ${plural(openList.length, "open exception")}`, {
        evidenceId: id,
        runs: runs.map((r) => ({ file: r.file_name, uploaded: when(r.created_at), rows: r.row_count, openExceptions: open.filter((i) => i.run_id === r.id).length })),
        openExceptions: openList,
        resolvedExceptions: items.length - open.length,
      });
    },
    {
      name: "reconciliation_overview",
      description: "Recent settlement-file reconciliations and the exceptions still open (amount mismatches, settled but pending here, missing in settlement).",
      schema: z.object({}),
    },
  );

  return [searchStudents, getStudentAccount, collections, listPayments, feeOverview, reconciliationOverview];
}

export function askToolLabel(name: string, args: Record<string, unknown>): string {
  const range = typeof args.from === "string" && typeof args.to === "string" ? ` ${formatDate(args.from)} to ${formatDate(args.to)}` : "";
  switch (name) {
    case "search_students": {
      const parts = [args.course, args.year ? `year ${String(args.year)}` : null, typeof args.status === "string" ? args.status.toLowerCase() : null].filter(Boolean);
      return `Searching students${parts.length ? ` (${parts.join(", ")})` : ""}`;
    }
    case "get_student_account":
      return `Opening ${String(args.nameOrRoll)}'s account`;
    case "collections":
      return `Adding up collections${range}${args.compareFrom ? " and the comparison period" : ""}`;
    case "list_payments":
      return `Listing ${typeof args.status === "string" ? `${args.status.toLowerCase()} ` : ""}payments${range}`;
    case "fee_overview":
      return `Reading the fee overview${args.course ? ` for ${String(args.course)}` : ""}`;
    case "reconciliation_overview":
      return "Checking reconciliation runs";
    default:
      return name;
  }
}
