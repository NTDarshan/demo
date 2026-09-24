// Temporary developer status page (Phase 2). Replaced by the real dashboard in Phase 3.
import { getDashboard } from "@/lib/data/dashboard";
import { SCENARIOS } from "@/lib/demo/scenarios";
import { formatINR } from "@/lib/money";

export const dynamic = "force-dynamic";

const ENDPOINTS: { method: "GET" | "POST"; path: string; href?: string; note: string }[] = [
  { method: "GET", path: "/api/dashboard", href: "/api/dashboard", note: "Summary, 30-day trend, overdue by course, needs attention" },
  { method: "GET", path: "/api/students?q=&status=&course=", href: "/api/students?status=OVERDUE", note: "Student balances (example: overdue)" },
  { method: "GET", path: "/api/students/[id or roll no]", href: "/api/students/CSE24-003", note: "Profile, installments, statement with running balance, payments" },
  { method: "GET", path: "/api/payments?status=&mode=&q=", href: "/api/payments?status=PENDING", note: "Payments (example: pending)" },
  { method: "GET", path: "/api/payments/[id]", note: "State track, allocations, ledger entries, audit" },
  { method: "POST", path: "/api/payments", note: "Record payment (idempotency key required)" },
  { method: "POST", path: "/api/payments/[id]/confirm | fail | reverse | check-status", note: "Lifecycle transitions" },
  { method: "POST", path: "/api/concessions", note: "Apply concession (admin)" },
  { method: "GET", path: "/api/reconciliation", href: "/api/reconciliation", note: "Previous runs" },
  { method: "POST", path: "/api/reconciliation", note: "Upload settlement CSV (multipart field: file)" },
  { method: "GET", path: "/api/reconciliation/[runId]", note: "Run detail by bucket" },
  { method: "POST", path: "/api/reconciliation/items/[id]/resolve", note: "Mark as paid / reviewed" },
  { method: "GET", path: "/api/audit?actor=&entity=&q=", href: "/api/audit?limit=25", note: "Audit log with readable sentences" },
  { method: "GET", path: "/api/role", href: "/api/role", note: "Current simulated role (POST to switch)" },
  { method: "POST", path: "/api/demo/reset", note: "Reset demo data (admin)" },
];

export default async function StatusPage() {
  let summary: Awaited<ReturnType<typeof getDashboard>>["summary"] | null = null;
  let error: string | null = null;
  try {
    summary = (await getDashboard()).summary;
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not load the dashboard.";
  }

  const figures = summary
    ? [
        ["Collected this term", formatINR(summary.collectedThisTermPaise, { paise: "auto" })],
        ["Outstanding", formatINR(summary.outstandingPaise, { paise: "auto" })],
        ["Overdue", `${formatINR(summary.overduePaise, { paise: "auto" })} (${summary.overdueStudents} students)`],
        ["Pending payments", `${summary.pendingCount} (${formatINR(summary.pendingPaise, { paise: "auto" })})`],
        ["Open reconciliation items", String(summary.openReconItems)],
      ]
    : [];

  return (
    <main className="mx-auto max-w-5xl px-8 py-10 text-[14px]">
      <h1 className="text-[28px] font-semibold">Kosha</h1>
      <p className="mt-1 text-muted">Phase 2 status: database, domain layer and API. The real interface arrives in Phase 3.</p>

      <section className="mt-8 rounded-[10px] border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 text-[16px] font-medium">Live figures from the database</h2>
        {error ? (
          <p className="px-5 py-4 text-debit">{error}</p>
        ) : (
          <dl className="grid grid-cols-1 divide-y divide-line sm:grid-cols-5 sm:divide-x sm:divide-y-0">
            {figures.map(([label, value]) => (
              <div key={label} className="px-5 py-4">
                <dt className="text-[12px] text-muted">{label}</dt>
                <dd className="mt-1 font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="mt-6 rounded-[10px] border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 text-[16px] font-medium">Scenario students</h2>
        <ul className="divide-y divide-line">
          {SCENARIOS.map((s) => (
            <li key={s.rollNo} className="flex flex-wrap items-baseline gap-x-4 px-5 py-2.5">
              <a className="font-mono text-[13px] text-accent hover:underline" href={`/api/students/${s.rollNo}`}>
                {s.rollNo}
              </a>
              <span className="font-medium">{s.name}</span>
              <span className="text-muted">{s.story}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 overflow-x-auto rounded-[10px] border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 text-[16px] font-medium">API endpoints</h2>
        <table className="w-full text-left">
          <tbody className="divide-y divide-line">
            {ENDPOINTS.map((e) => (
              <tr key={e.method + e.path}>
                <td className="w-16 px-5 py-2 font-mono text-[12px] text-muted">{e.method}</td>
                <td className="px-2 py-2 font-mono text-[13px]">
                  {e.href ? (
                    <a className="text-accent hover:underline" href={e.href}>
                      {e.path}
                    </a>
                  ) : (
                    e.path
                  )}
                </td>
                <td className="px-5 py-2 text-muted">{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
