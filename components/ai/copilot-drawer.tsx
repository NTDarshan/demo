"use client";

// The Reconciliation Copilot drawer. It streams the agent's steps while it investigates,
// then shows the diagnosis with its evidence and the checks the server ran on it.
// Nothing changes until a person presses Accept, which goes through
// decide_ai_investigation() → resolve_recon_item() in the database.

import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, Loader2, RotateCw, ShieldCheck, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { StatusBadge, type Tone } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { ROLE_LABEL, isRole } from "@/lib/auth/permissions";
import { api, ApiClientError } from "@/lib/client/api";
import { streamInvestigation } from "@/lib/client/copilot";
import { cn } from "@/lib/cn";
import type { ReconRunItem } from "@/lib/data/reconciliation";
import { formatDateTime } from "@/lib/dates";
import { BUCKET_LABEL } from "@/lib/domain/reconcile";
import { formatINR } from "@/lib/money";
import { ACTION_LABEL, ROOT_CAUSE_LABEL, type Confidence } from "@/lib/ai/recon-copilot/schema";
import type { CopilotEvent, Investigation } from "@/lib/ai/recon-copilot/types";

type Step = { id: string; label: string; state: "running" | "done" | "error"; detail?: string | null };

export const CONFIDENCE_TONE: Record<Confidence, Tone> = { high: "credit", medium: "pending", low: "debit" };

export function CopilotDrawer({
  item,
  existing,
  onClose,
  onResolveByHand,
}: {
  item: ReconRunItem | null;
  existing: Investigation | null;
  onClose: () => void;
  onResolveByHand: (item: ReconRunItem) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Investigation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [deciding, setDeciding] = useState<"ACCEPT" | "DISMISS" | null>(null);
  const abort = useRef<AbortController | null>(null);

  const start = useCallback(async (target: ReconRunItem) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSteps([]);
    setResult(null);
    setError(null);
    setRunning(true);
    const onEvent = (e: CopilotEvent) => {
      if (e.type !== "step") return;
      setSteps((prev) => {
        const i = prev.findIndex((s) => s.id === e.id);
        const next: Step = { id: e.id, label: e.label, state: e.state, detail: e.detail };
        if (i === -1) return [...prev, next];
        const copy = [...prev];
        copy[i] = next;
        return copy;
      });
    };
    try {
      const inv = await streamInvestigation(target.id, onEvent, ctrl.signal);
      setResult(inv);
      setNote(inv.diagnosis.recommendation.note);
      router.refresh();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof ApiClientError ? err.message : "The Copilot hit an unexpected error. Nothing was changed.");
    } finally {
      if (abort.current === ctrl) setRunning(false);
    }
  }, [router]);

  // Opening the drawer: show the saved proposal, or start a fresh investigation.
  useEffect(() => {
    if (!item) return;
    setDismissing(false);
    setDismissReason("");
    if (existing) {
      setResult(existing);
      setNote(existing.diagnosis.recommendation.note);
      setSteps(existing.trace.map((t, i) => ({ id: `t${i}`, label: t.label, state: t.error ? "error" : "done", detail: t.summary })));
      setError(null);
    } else {
      void start(item);
    }
    return () => abort.current?.abort();
    // Only when a different item is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  function close() {
    if (deciding) return;
    abort.current?.abort();
    setRunning(false);
    onClose();
  }

  async function decide(decision: "ACCEPT" | "DISMISS") {
    if (!result || deciding) return;
    if (decision === "DISMISS" && dismissReason.trim().length < 3) {
      setError("Say briefly why you are not using the suggestion.");
      return;
    }
    setDeciding(decision);
    setError(null);
    try {
      await api(`/api/ai/investigations/${result.id}/decide`, {
        body: { decision, note: decision === "ACCEPT" ? note.trim() || null : dismissReason.trim() },
      });
      toast.success(
        decision === "ACCEPT" ? `${ACTION_LABEL[result.recommendation]}: done` : "Suggestion dismissed",
        decision === "ACCEPT" && result.recommendation === "MARK_PAID" ? `${item?.gatewayRef} confirmed; receipt issued.` : item?.gatewayRef,
      );
      setDeciding(null);
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong. Nothing was changed.");
      setDeciding(null);
    }
  }

  const open = result?.status === "PROPOSED";
  const acceptable = open && result.recommendation !== "ESCALATE";

  return (
    <Sheet open={item !== null} onOpenChange={(o) => !o && close()}>
      {item ? (
        <SheetContent
          className="max-w-[600px]"
          title="Reconciliation Copilot"
          description={
            <span>
              <span className="font-mono">{item.gatewayRef}</span>
              {item.student ? ` · ${item.student.name}` : ""} · {BUCKET_LABEL[item.bucket]}
            </span>
          }
          footer={
            <Footer
              running={running}
              result={result}
              acceptable={Boolean(acceptable)}
              open={Boolean(open)}
              dismissing={dismissing}
              deciding={deciding}
              onRerun={() => void start(item)}
              onDismissStart={() => setDismissing(true)}
              onDismissCancel={() => {
                setDismissing(false);
                setError(null);
              }}
              onDecide={decide}
              onByHand={() => {
                onClose();
                onResolveByHand(item);
              }}
              onClose={close}
            />
          }
        >
          <div className="space-y-5">
            <CaseStrip item={item} />

            <section aria-label="Investigation steps">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{running ? "Investigating" : "What the Copilot checked"}</h3>
              <ol className="space-y-1.5">
                {steps.map((s) => (
                  <li key={s.id} className="flex gap-2.5 text-sm animate-pop-in">
                    <span className="mt-0.5 shrink-0">
                      {s.state === "running" ? (
                        <Loader2 className="size-4 animate-spin text-accent" aria-label="Running" />
                      ) : s.state === "error" ? (
                        <AlertTriangle className="size-4 text-pending" aria-label="Warning" />
                      ) : (
                        <Check className="size-4 text-credit" aria-label="Done" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className={cn(s.state === "running" && "text-ink", s.state !== "running" && "text-ink")}>{s.label}</span>
                      {s.detail ? <span className="block text-muted">{s.detail}</span> : null}
                    </span>
                  </li>
                ))}
                {running && steps.length === 0 ? (
                  <li className="flex gap-2.5 text-sm text-muted">
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Starting
                  </li>
                ) : null}
              </ol>
            </section>

            {result ? <ResultView result={result} note={note} setNote={setNote} editable={Boolean(acceptable)} /> : null}

            {dismissing ? (
              <div>
                <Label htmlFor="c-dismiss">Why are you not using this suggestion?</Label>
                <Textarea id="c-dismiss" value={dismissReason} onChange={(e) => setDismissReason(e.target.value)} maxLength={300} placeholder="e.g. Gateway support says it settles in tomorrow's batch" />
              </div>
            ) : null}

            {error ? (
              <div role="alert" className="flex gap-2.5 rounded tint-debit px-3.5 py-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p className="text-ink">{error}</p>
              </div>
            ) : null}
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function CaseStrip({ item }: { item: ReconRunItem }) {
  const diff = item.fileAmountPaise !== null && item.systemAmountPaise !== null ? item.fileAmountPaise - item.systemAmountPaise : null;
  return (
    <dl className="grid grid-cols-3 gap-px overflow-hidden rounded border border-line bg-line text-sm">
      <div className="bg-surface px-3 py-2">
        <dt className="text-xs text-muted">In file</dt>
        <dd className="figure font-medium">{item.fileAmountPaise !== null ? formatINR(item.fileAmountPaise, { paise: "auto" }) : "Not in file"}</dd>
      </div>
      <div className="bg-surface px-3 py-2">
        <dt className="text-xs text-muted">Recorded here</dt>
        <dd className="figure font-medium">{item.systemAmountPaise !== null ? formatINR(item.systemAmountPaise, { paise: "auto" }) : "–"}</dd>
      </div>
      <div className="bg-surface px-3 py-2">
        <dt className="text-xs text-muted">{diff !== null && diff !== 0 ? "Difference" : "Payment now"}</dt>
        <dd className={cn("figure font-medium", diff ? "text-debit" : "")}>
          {diff !== null && diff !== 0 ? `${diff > 0 ? "+" : "−"}${formatINR(Math.abs(diff), { paise: "auto" })}` : (item.currentPaymentStatus ?? "–").toLowerCase()}
        </dd>
      </div>
    </dl>
  );
}

function ResultView({ result, note, setNote, editable }: { result: Investigation; note: string; setNote: (s: string) => void; editable: boolean }) {
  const d = result.diagnosis;
  const evidence = new Map(result.evidence.map((e) => [e.id, e]));
  const v = result.verification;
  const figures = v.verifiedAmountCount;
  return (
    <div className="space-y-5">
      <section className="rounded-panel border border-line p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
            <Sparkles className="size-3.5" aria-hidden /> Diagnosis
          </span>
          <StatusBadge tone="neutral">{ROOT_CAUSE_LABEL[d.rootCause]}</StatusBadge>
          <StatusBadge tone={CONFIDENCE_TONE[d.confidence]}>{d.confidence} confidence</StatusBadge>
        </div>
        <p className="text-md font-semibold leading-snug">{d.headline}</p>
        <ol className="mt-3 space-y-2.5">
          {d.findings.map((f, i) => (
            <li key={i} className="flex gap-2.5 text-sm">
              <span className="figure mt-px w-4 shrink-0 text-muted">{i + 1}.</span>
              <span className="min-w-0">
                {f.text}
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {f.evidence.map((id) => {
                    const e = evidence.get(id);
                    const label = e?.label ?? id;
                    return e?.href ? (
                      <Link key={id} href={e.href} className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-px text-xs text-muted hover:border-accent hover:text-accent">
                        {label}
                        <ExternalLink className="size-3" aria-hidden />
                      </Link>
                    ) : (
                      <span key={id} className="inline-flex rounded-sm border border-line px-1.5 py-px text-xs text-muted">
                        {label}
                      </span>
                    );
                  })}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className={cn("flex gap-2.5 rounded px-3.5 py-3 text-sm", v.ok ? "tint-credit" : "tint-pending")}>
        {v.ok ? <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <div className="text-ink">
          <p className="font-medium">{v.ok ? "Checked against the database" : "Some checks did not pass"}</p>
          <p className="text-muted">
            {v.ok
              ? `${figures} rupee figure${figures === 1 ? "" : "s"} and every cited record were found in what the tools returned. The suggested action is allowed for this item.`
              : v.checks
                  .filter((c) => !c.ok)
                  .map((c) => c.detail)
                  .join(" ")}
          </p>
        </div>
      </section>

      <section className="rounded-panel border border-line p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Suggested action</p>
        <p className="mt-1 text-md font-semibold">{ACTION_LABEL[d.recommendation.action]}</p>
        <p className="mt-1 text-sm text-muted">{d.recommendation.reason}</p>
        {editable ? (
          <div className="mt-3">
            <Label htmlFor="c-note">Note saved on the item (you can edit it)</Label>
            <Textarea id="c-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </div>
        ) : null}
      </section>

      {d.gatewayQuery ? <GatewayQuery text={d.gatewayQuery} /> : null}

      {d.nextSteps.length || d.risks.length ? (
        <div className={cn("grid gap-4", d.nextSteps.length && d.risks.length ? "sm:grid-cols-2" : "")}>
          {d.nextSteps.length ? (
            <section>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Next steps</h3>
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {d.nextSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {d.risks.length ? (
            <section>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Could be wrong if</h3>
              <ul className="list-disc space-y-1 pl-4 text-sm text-muted">
                {d.risks.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-muted">
        {result.status === "ACCEPTED" || result.status === "DISMISSED" ? (
          <span className="mb-1 flex items-center gap-1.5 text-ink">
            {result.status === "ACCEPTED" ? <CheckCircle2 className="size-3.5 text-credit" aria-hidden /> : <X className="size-3.5" aria-hidden />}
            {result.status === "ACCEPTED" ? "Accepted" : "Dismissed"} by {isRole(result.decidedBy) ? ROLE_LABEL[result.decidedBy] : result.decidedBy}
            {result.decidedAt ? ` on ${formatDateTime(result.decidedAt)}` : ""}
            {result.decisionNote && result.status === "DISMISSED" ? `: ${result.decisionNote}` : ""}
          </span>
        ) : null}
        Investigated {formatDateTime(result.createdAt)} · {result.trace.length} lookup{result.trace.length === 1 ? "" : "s"} · {(result.latencyMs / 1000).toFixed(1)}s ·{" "}
        {result.usage.total.toLocaleString("en-IN")} tokens · {result.model}
      </p>
    </div>
  );
}

function GatewayQuery({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-panel border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Draft message to the gateway</p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            });
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="whitespace-pre-wrap px-4 py-3 text-sm">{text}</p>
    </section>
  );
}

function Footer(props: {
  running: boolean;
  result: Investigation | null;
  acceptable: boolean;
  open: boolean;
  dismissing: boolean;
  deciding: "ACCEPT" | "DISMISS" | null;
  onRerun: () => void;
  onDismissStart: () => void;
  onDismissCancel: () => void;
  onDecide: (d: "ACCEPT" | "DISMISS") => void;
  onByHand: () => void;
  onClose: () => void;
}) {
  const { running, result, acceptable, open, dismissing, deciding } = props;
  if (running) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Read-only lookups. Nothing changes until you accept.</p>
        <Button variant="secondary" onClick={props.onClose}>
          Stop
        </Button>
      </div>
    );
  }
  if (dismissing) {
    return (
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={props.onDismissCancel} disabled={deciding !== null}>
          Back
        </Button>
        <Button onClick={() => props.onDecide("DISMISS")} loading={deciding === "DISMISS"}>
          Dismiss suggestion
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" onClick={props.onRerun} disabled={deciding !== null || (result !== null && !open && result.status !== "SUPERSEDED")}>
        <RotateCw aria-hidden /> Investigate again
      </Button>
      <div className="flex flex-wrap justify-end gap-2">
        {open ? (
          <Button variant="secondary" onClick={props.onDismissStart} disabled={deciding !== null}>
            Dismiss
          </Button>
        ) : null}
        {open && !acceptable ? (
          <Button onClick={props.onByHand} disabled={deciding !== null}>
            Resolve by hand
          </Button>
        ) : null}
        {acceptable && result ? (
          <Button onClick={() => props.onDecide("ACCEPT")} loading={deciding === "ACCEPT"}>
            Accept: {ACTION_LABEL[result.recommendation].toLowerCase()}
          </Button>
        ) : null}
        {!open ? (
          <Button variant="secondary" onClick={props.onClose}>
            Close
          </Button>
        ) : null}
      </div>
    </div>
  );
}
