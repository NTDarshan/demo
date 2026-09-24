import type { Metadata } from "next";
import Link from "next/link";
import { Money } from "@/components/money";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/ui/panel";
import { guardPage } from "@/lib/auth/page-guard";
import { getDashboard } from "@/lib/data/dashboard";
import { formatDate } from "@/lib/dates";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

// Phase 3: the summary strip only. The trend, overdue-by-course and needs-attention
// panels are built in Phase 5.
export default async function DashboardPage() {
  await guardPage("dashboard.view");
  const d = await getDashboard();
  const s = d.summary;

  const cells = [
    { label: `Collected this term`, value: <Money paise={s.collectedThisTermPaise} auto />, note: `${s.collectedThisTermCount} payments since ${formatDate(d.term.from)}` },
    { label: "Outstanding", value: <Money paise={s.outstandingPaise} auto />, note: "Billed but not yet paid, all terms" },
    { label: "Overdue", value: <Money paise={s.overduePaise} auto className="text-debit" />, note: `${s.overdueStudents} students past a due date`, href: "/students?status=OVERDUE" },
    { label: "Pending payments", value: <span className="figure">{s.pendingCount}</span>, note: s.pendingCount ? "Waiting for the gateway" : "Nothing waiting", href: "/payments?status=PENDING" },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description={`Fee collection for ${d.term.label}, as of ${formatDate(d.asOf)}.`} />
      {/* One bordered strip with dividers: 1 column on phones, 2x2 on tablets, 4 across on desktop. */}
      <section aria-label="Summary" className="grid grid-cols-1 overflow-hidden rounded-panel border border-line bg-surface sm:grid-cols-2 lg:grid-cols-4">
        {cells.map((c, i) => {
          const divider = cn(
            "border-line",
            i < cells.length - 1 && "border-b",
            i >= 2 && "sm:border-b-0",
            i % 2 === 0 && "sm:border-r",
            "lg:border-b-0",
            i < cells.length - 1 ? "lg:border-r" : "lg:border-r-0",
          );
          const body = (
            <>
              <p className="text-sm text-muted">{c.label}</p>
              <p className="mt-1 text-xl font-semibold">{c.value}</p>
              <p className="mt-1 text-sm text-muted">{c.note}</p>
            </>
          );
          return c.href ? (
            <Link key={c.label} href={c.href} className={cn("block px-5 py-4 transition-colors hover:bg-canvas/60", divider)}>
              {body}
            </Link>
          ) : (
            <div key={c.label} className={cn("px-5 py-4", divider)}>
              {body}
            </div>
          );
        })}
      </section>
    </>
  );
}
