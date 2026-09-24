import { Panel, PanelHeader } from "@/components/ui/panel";
import type { FeeHeadSummary } from "@/lib/data/students";
import { formatINR } from "@/lib/money";

const money = (p: number) => formatINR(p, { paise: "auto" });

const SEGMENTS = [
  { key: "paid", label: "Paid", className: "bg-credit" },
  { key: "concession", label: "Concession", className: "bg-reversed/70" },
  { key: "overdue", label: "Overdue", className: "bg-debit" },
  { key: "upcoming", label: "Not yet due", className: "bg-line-strong" },
] as const;

/** One segmented bar per fee head: paid / concession / overdue / not yet due, with exact figures. */
export function FeeHeadTracker({ heads }: { heads: FeeHeadSummary[] }) {
  return (
    <Panel>
      <PanelHeader
        title="Fee heads"
        actions={
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
            {SEGMENTS.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className={`size-2 rounded-sm ${s.className}`} aria-hidden />
                {s.label}
              </li>
            ))}
          </ul>
        }
      />
      <ul className="divide-y divide-line">
        {heads.map((h) => {
          const upcoming = h.remainingPaise - h.overduePaise;
          const parts = { paid: h.paidPaise, concession: h.concessionPaise, overdue: h.overduePaise, upcoming };
          const summary = [
            h.paidPaise > 0 ? `${money(h.paidPaise)} paid` : null,
            h.concessionPaise > 0 ? `${money(h.concessionPaise)} concession` : null,
            h.overduePaise > 0 ? `${money(h.overduePaise)} overdue` : null,
            upcoming > 0 ? `${money(upcoming)} not yet due` : null,
          ].filter(Boolean);
          return (
            <li key={h.feeHead} className="grid gap-2 px-5 py-3.5 sm:grid-cols-[120px_1fr_300px] sm:items-center sm:gap-5">
              <div className="flex items-baseline justify-between sm:block">
                <p className="font-medium">{h.feeHead}</p>
                <p className="figure text-sm text-muted">of {money(h.demandPaise)}</p>
              </div>
              <div
                className="flex h-2.5 overflow-hidden rounded-full bg-canvas"
                role="img"
                aria-label={`${h.feeHead}: ${summary.join(", ") || "nothing billed"}`}
              >
                {SEGMENTS.map((s) => {
                  const value = parts[s.key];
                  if (value <= 0 || h.demandPaise <= 0) return null;
                  return <span key={s.key} className={`${s.className} h-full border-r border-surface last:border-r-0`} style={{ width: `${(value / h.demandPaise) * 100}%` }} />;
                })}
              </div>
              <p className="figure text-sm text-muted sm:text-right">
                {h.remainingPaise === 0 ? <span className="text-credit">Cleared</span> : <span className="font-medium text-ink">{money(h.remainingPaise)} left</span>}
                {summary.length > 0 ? <span className="block text-xs">{summary.join(" · ")}</span> : null}
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
