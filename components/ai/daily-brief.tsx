"use client";

// Today's brief on the dashboard: the three things that need attention, with links to act.
// The first dashboard visit of the day writes it; after that it is read from the database, and
// the card says when the ledger has changed since it was written.

import { AlertTriangle, ArrowRight, Loader2, RotateCw, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import type { SavedBrief } from "@/lib/data/brief";
import { formatDate, formatDateTime } from "@/lib/dates";

function tone(severity: number) {
  return severity >= 70 ? "bg-debit" : severity >= 45 ? "bg-pending" : "bg-accent";
}

export function DailyBrief({ initial, fingerprint, className }: { initial: SavedBrief | null; fingerprint: string; className?: string }) {
  const router = useRouter();
  const [brief, setBrief] = useState<SavedBrief | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBrief(await api<SavedBrief>("/api/ai/brief", { body: {} }));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not write today's brief.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!initial && !started.current) {
      started.current = true;
      void generate();
    }
  }, [initial, generate]);

  useEffect(() => setBrief(initial ?? brief), [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const stale = brief !== null && brief.fingerprint !== fingerprint;
  const byId = new Map((brief?.signals ?? []).map((s) => [s.id, s]));
  const picked = new Set(brief?.items.map((i) => i.signalId));
  const others = (brief?.signals ?? []).filter((s) => !picked.has(s.id));

  return (
    <section aria-label="Today's brief" className={cn("rounded-panel border border-line bg-surface", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" aria-hidden />
          <h2 className="font-semibold">Today&apos;s brief</h2>
          <span className="text-sm text-muted">{brief ? `${formatDate(brief.date)} · written ${formatDateTime(brief.createdAt).split(", ")[1]}` : ""}</span>
        </div>
        <div className="flex items-center gap-2">
          {stale && !loading ? <span className="text-xs text-pending">The ledger has changed since this was written</span> : null}
          <Button size="sm" variant={stale ? "primary" : "ghost"} onClick={() => void generate()} loading={loading} disabled={loading}>
            {loading ? null : <RotateCw aria-hidden />}
            {loading ? "Reading the ledger" : "Refresh"}
          </Button>
        </div>
      </div>

      {loading && !brief ? (
        <div className="space-y-3 px-5 py-5" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin text-accent" aria-hidden /> Checking pending payments, reconciliation, overdue fees and collections
          </p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-canvas" />
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="m-5 flex gap-2 rounded tint-debit px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="text-ink">{error}</span>
        </p>
      ) : null}

      {brief ? (
        <div className={cn("px-5 py-4", loading && "opacity-60")}>
          <p className="text-md font-medium">{brief.headline}</p>
          {brief.items.length ? (
            <ol className="mt-3 divide-y divide-line">
              {brief.items.map((item, n) => {
                const s = byId.get(item.signalId);
                if (!s) return null;
                const action = s.actions.find((a) => a.id === item.actionId) ?? s.actions[0];
                return (
                  <li key={item.signalId} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6">
                    <div className="flex gap-3">
                      <span className="figure mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-canvas text-xs font-semibold">{n + 1}</span>
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          <span className={cn("size-2 shrink-0 rounded-full", tone(s.severity))} aria-hidden />
                          {s.title}
                        </p>
                        <p className="mt-0.5 text-sm text-muted">{item.why}</p>
                        {s.examples.length ? (
                          <p className="mt-1.5 flex flex-wrap gap-1.5">
                            {s.examples.map((e) => (
                              <Link key={e.href + e.label} href={e.href} className="rounded-sm border border-line px-1.5 py-px text-xs text-muted hover:border-accent hover:text-accent" title={e.detail}>
                                {e.label} · {e.detail}
                              </Link>
                            ))}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {action ? (
                      <Button asChild size="sm" variant="secondary" className="justify-self-start sm:justify-self-end">
                        <Link href={action.href}>
                          {action.label}
                          <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {others.length ? (
            <p className="mt-2 text-sm text-muted">
              <span className="font-medium text-ink">Also noted: </span>
              {others.map((o) => o.title).join(" · ")}
            </p>
          ) : null}
          <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {brief.generatedBy === "ai" ? <ShieldCheck className="size-3.5 text-credit" aria-hidden /> : null}
            {brief.generatedBy === "ai"
              ? `Signals found by code; picked and explained by ${brief.model}; ${brief.checks.find((c) => c.name === "Figures match the ledger")?.detail.toLowerCase() ?? "figures checked"}`
              : "Written by rules from the ledger (the AI was not available)"}
          </p>
        </div>
      ) : null}
    </section>
  );
}
