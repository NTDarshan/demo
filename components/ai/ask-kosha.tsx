"use client";

// Ask Kosha: plain-English questions about the college's fees, answered by a LangGraph agent
// from read-only lookups. Opens from the top bar (or Ctrl+J) on every page, keeps the
// conversation while you move between pages, and links every row to its record.

import { AlertTriangle, ArrowUp, Check, ChevronRight, ExternalLink, Loader2, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ApiClientError } from "@/lib/client/api";
import { postNdjson } from "@/lib/client/stream";
import { cn } from "@/lib/cn";
import type { AskEvent, AskResult, AskTurn } from "@/lib/ai/ask/types";

export const EXAMPLE_QUESTIONS = [
  "Which students owe more than ₹1,00,000 and are overdue?",
  "How much did we collect last week compared with the week before, by mode?",
  "What is our collection rate by course?",
  "Who has a payment stuck in pending?",
  "What falls due in the next 30 days?",
  "Show Rohan Kulkarni's account",
];

const NUMERIC = /^([+−-]\s?)?(₹[\d,]+(\.\d+)?|[\d,]+(\.\d+)?%?)$|^[–-]$/;

type Step = { id: string; label: string; state: "running" | "done" | "error"; detail?: string | null };
type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; steps: Step[]; result: AskResult | null; error: string | null; pending: boolean };

type Ctx = { enabled: boolean; open: (question?: string) => void };
const AskContext = createContext<Ctx>({ enabled: false, open: () => {} });
export const useAskKosha = () => useContext(AskContext);

/** What the model sees of an earlier answer: the text plus the table rows (so "only the BCA ones" works). */
function historyText(r: AskResult): string {
  const table = r.table.columns.length
    ? `\n\n${r.table.title}\n${r.table.columns.join(" | ")}\n${r.table.rows.map((row) => row.cells.join(" | ")).join("\n")}`
    : "";
  return `${r.answer}${table}`.slice(0, 3800);
}

export function AskKoshaProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const busy = messages.some((m) => m.role === "assistant" && m.pending);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      const history: AskTurn[] = messages.flatMap((m): AskTurn[] =>
        m.role === "user" ? [{ role: "user", content: m.text }] : m.result ? [{ role: "assistant", content: historyText(m.result) }] : [],
      );
      const userId = nextId.current++;
      const botId = nextId.current++;
      setMessages((prev) => [...prev, { id: userId, role: "user", text: q }, { id: botId, role: "assistant", steps: [], result: null, error: null, pending: true }]);
      setDraft("");
      const update = (fn: (m: Extract<Message, { role: "assistant" }>) => Extract<Message, { role: "assistant" }>) =>
        setMessages((prev) => prev.map((m) => (m.id === botId && m.role === "assistant" ? fn(m) : m)));

      const ctrl = new AbortController();
      abort.current = ctrl;
      try {
        await postNdjson<AskEvent>(
          "/api/ai/ask",
          { question: q, history: history.slice(-8) },
          (e) => {
            if (e.type === "step") {
              update((m) => {
                const i = m.steps.findIndex((s) => s.id === e.id);
                const step = { id: e.id, label: e.label, state: e.state, detail: e.detail };
                return { ...m, steps: i === -1 ? [...m.steps, step] : m.steps.map((s, j) => (j === i ? step : s)) };
              });
            } else if (e.type === "done") {
              update((m) => ({ ...m, result: e.result, pending: false }));
            } else {
              update((m) => ({ ...m, error: e.message, pending: false }));
            }
          },
          ctrl.signal,
        );
        update((m) => (m.pending ? { ...m, pending: false, error: m.result ? null : "The answer stopped before it finished. Try again." } : m));
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          update((m) => ({ ...m, pending: false, error: "Stopped." }));
          return;
        }
        update((m) => ({ ...m, pending: false, error: err instanceof ApiClientError ? err.message : "Ask Kosha could not answer that. Try again." }));
      }
    },
    [busy, messages],
  );

  const open = useCallback(
    (question?: string) => {
      setOpen(true);
      if (question) void ask(question);
    },
    [ask],
  );

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  const value = useMemo(() => ({ enabled, open }), [enabled, open]);

  return (
    <AskContext.Provider value={value}>
      {children}
      {enabled ? (
        <Sheet open={isOpen} onOpenChange={setOpen}>
          <SheetContent
            className="max-w-[640px]"
            title="Ask Kosha"
            description="Questions about fees, answered from the ledger. Read-only."
            footer={
              <Composer
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                onSend={() => void ask(draft)}
                onStop={() => abort.current?.abort()}
                onReset={messages.length ? () => setMessages([]) : null}
              />
            }
          >
            <Conversation messages={messages} onAsk={(q) => void ask(q)} busy={busy} onClose={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
      ) : null}
    </AskContext.Provider>
  );
}

export function AskKoshaButton() {
  const { enabled, open } = useAskKosha();
  if (!enabled) return null;
  return (
    <Button variant="secondary" onClick={() => open()} className="text-accent" aria-keyshortcuts="Control+J" title="Ask Kosha (Ctrl+J)">
      <Sparkles aria-hidden />
      <span className="hidden md:inline">Ask Kosha</span>
    </Button>
  );
}

/** Example questions, for the dashboard. */
export function AskKoshaSuggestions({ className }: { className?: string }) {
  const { enabled, open } = useAskKosha();
  if (!enabled) return null;
  return (
    <div className={cn("flex flex-col gap-3 rounded-panel border border-accent/25 bg-accent/5 px-5 py-4", className)}>
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-accent" aria-hidden />
        <p className="font-medium">Ask Kosha</p>
        <span className="hidden text-sm text-muted sm:inline">Ask about fees in plain English. Every figure is checked against the ledger.</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {EXAMPLE_QUESTIONS.slice(0, 4).map((q) => (
          <button key={q} type="button" onClick={() => open(q)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm hover:border-accent hover:text-accent">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Conversation({ messages, onAsk, busy, onClose }: { messages: Message[]; onAsk: (q: string) => void; busy: boolean; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  const lastKey = last ? `${last.id}:${last.role === "assistant" ? `${last.steps.length}:${Boolean(last.result)}` : ""}` : "";
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lastKey]);

  if (messages.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Ask about balances, overdue students, collections, pending payments or reconciliation. Answers come from the same data as the rest of Kosha, and every rupee figure is checked against it before it is shown.
        </p>
        <div className="grid gap-2">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button key={q} type="button" onClick={() => onAsk(q)} className="flex items-center justify-between gap-3 rounded border border-line px-3.5 py-2.5 text-left text-sm hover:border-accent hover:text-accent">
              {q}
              <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5" aria-live="polite">
      {messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-panel bg-ink px-3.5 py-2 text-sm text-white">{m.text}</p>
          </div>
        ) : (
          <AssistantMessage key={m.id} m={m} onAsk={onAsk} busy={busy} onClose={onClose} />
        ),
      )}
      <div ref={end} />
    </div>
  );
}

function AssistantMessage({ m, onAsk, busy, onClose }: { m: Extract<Message, { role: "assistant" }>; onAsk: (q: string) => void; busy: boolean; onClose: () => void }) {
  const r = m.result;
  const evidence = new Map((r?.evidence ?? []).map((e) => [e.id, e]));
  const tableRefs = new Set(r?.table.rows.map((row) => row.ref) ?? []);
  const numericCols = (r?.table.columns ?? []).map((_, j) => Boolean(r?.table.rows.length) && r!.table.rows.every((row) => NUMERIC.test(row.cells[j] ?? "")));
  const sources = (r?.sources ?? []).filter((s) => !tableRefs.has(s)).map((s) => evidence.get(s)).filter((e): e is NonNullable<typeof e> => Boolean(e)).slice(0, 6);

  return (
    <div className="space-y-3">
      {m.pending ? (
        <ol className="space-y-1.5">
          {m.steps.map((s) => (
            <li key={s.id} className="flex gap-2 text-sm animate-pop-in">
              {s.state === "running" ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" aria-hidden /> : s.state === "error" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-pending" aria-hidden /> : <Check className="mt-0.5 size-4 shrink-0 text-credit" aria-hidden />}
              <span>
                {s.label}
                {s.detail ? <span className="block text-muted">{s.detail}</span> : null}
              </span>
            </li>
          ))}
          {m.steps.length === 0 ? (
            <li className="flex gap-2 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Starting
            </li>
          ) : null}
        </ol>
      ) : null}

      {r ? (
        <>
          <RichText text={r.answer} />
          {r.table.columns.length && r.table.rows.length ? (
            <div className="overflow-hidden rounded-panel border border-line">
              {r.table.title ? <p className="border-b border-line bg-canvas px-3 py-2 text-xs font-medium text-muted">{r.table.title}</p> : null}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      {r.table.columns.map((c, i) => (
                        <th key={i} scope="col" className={cn("px-3 py-2 align-bottom font-medium", numericCols[i] && "text-right")}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.table.rows.map((row, i) => {
                      const href = row.ref ? evidence.get(row.ref)?.href : null;
                      return (
                        <tr key={i} className="border-b border-line last:border-0">
                          {row.cells.map((cell, j) => (
                            <td key={j} className={cn("px-3 py-2 align-top", numericCols[j] && "figure whitespace-nowrap text-right")}>
                              {j === 0 && href ? (
                                <Link href={href} onClick={onClose} className="font-medium text-accent hover:underline">
                                  {cell}
                                </Link>
                              ) : (
                                cell
                              )}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {sources.length ? (
            <div className="flex flex-wrap gap-1.5">
              {sources.map((e) =>
                e.href ? (
                  <Link key={e.id} href={e.href} onClick={onClose} className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-px text-xs text-muted hover:border-accent hover:text-accent">
                    {e.label}
                    <ExternalLink className="size-3" aria-hidden />
                  </Link>
                ) : (
                  <span key={e.id} className="rounded-sm border border-line px-1.5 py-px text-xs text-muted">
                    {e.label}
                  </span>
                ),
              )}
            </div>
          ) : null}

          <details className="group text-xs text-muted">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-ink">
              {r.verification.ok ? <ShieldCheck className="size-3.5 text-credit" aria-hidden /> : <AlertTriangle className="size-3.5 text-pending" aria-hidden />}
              <span className={r.verification.ok ? "" : "text-pending"}>
                {r.verification.ok
                  ? r.verification.verifiedAmountCount
                    ? `${r.verification.verifiedAmountCount} figure${r.verification.verifiedAmountCount === 1 ? "" : "s"} checked against the ledger`
                    : "Checked against the ledger"
                  : `Could not check: ${r.verification.unverifiedAmounts.join(", ") || "some references"}. Treat with care.`}
              </span>
              <span>
                · {r.lookups.length} lookup{r.lookups.length === 1 ? "" : "s"} · {(r.latencyMs / 1000).toFixed(1)}s
              </span>
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
            </summary>
            <ul className="mt-2 space-y-1 border-l border-line pl-3">
              {r.lookups.map((l, i) => (
                <li key={i}>
                  {l.label}
                  {l.summary ? `: ${l.summary}` : ""}
                </li>
              ))}
              {r.verification.checks.map((c) => (
                <li key={c.name}>
                  {c.ok ? "✓" : "✗"} {c.detail}
                </li>
              ))}
              <li>
                {r.usage.total.toLocaleString("en-IN")} tokens · {r.model}
              </li>
            </ul>
          </details>

          {r.followUps.length ? (
            <div className="flex flex-wrap gap-1.5">
              {r.followUps.map((f) => (
                <button key={f} type="button" disabled={busy} onClick={() => onAsk(f)} className="rounded-full border border-line px-2.5 py-1 text-xs hover:border-accent hover:text-accent disabled:opacity-55">
                  {f}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {m.error ? (
        <p role="alert" className="flex gap-2 rounded tint-debit px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="text-ink">{m.error}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Paragraphs, "- " lists and **bold**. Built as React nodes, so model output can never inject HTML. */
function RichText({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2 text-base leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (lines.length && lines.every((l) => /^\s*[-•]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-•]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        // A paragraph followed by list lines in the same block.
        const firstList = lines.findIndex((l) => /^\s*[-•]\s+/.test(l));
        if (firstList > 0) {
          return (
            <div key={i} className="space-y-1">
              <p>{inline(lines.slice(0, firstList).join(" "))}</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {lines.slice(firstList).map((l, j) => (
                  <li key={j}>{inline(l.replace(/^\s*[-•]\s+/, ""))}</li>
                ))}
              </ul>
            </div>
          );
        }
        return <p key={i}>{inline(lines.join(" "))}</p>;
      })}
    </div>
  );
}

function Composer({ draft, setDraft, busy, onSend, onStop, onReset }: { draft: string; setDraft: (s: string) => void; busy: boolean; onSend: () => void; onStop: () => void; onReset: (() => void) | null }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      className="space-y-2"
    >
      <div className="flex items-end gap-2 rounded border border-line-strong bg-surface p-1.5 focus-within:border-accent">
        <label htmlFor="ask-input" className="sr-only">
          Your question
        </label>
        <textarea
          id="ask-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          maxLength={500}
          placeholder="e.g. Which BCA students are overdue by more than 30 days?"
          className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted"
          autoFocus
        />
        {busy ? (
          <Button type="button" size="icon-sm" variant="secondary" onClick={onStop} aria-label="Stop">
            <span className="size-2.5 rounded-sm bg-ink" aria-hidden />
          </Button>
        ) : (
          <Button type="submit" size="icon-sm" disabled={draft.trim().length < 2} aria-label="Ask">
            <ArrowUp aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="hidden sm:inline">Enter to ask · Shift+Enter for a new line · Read-only: it cannot change anything</span>
        <span className="sm:hidden">Read-only</span>
        {onReset ? (
          <button type="button" onClick={onReset} disabled={busy} className="inline-flex items-center gap-1 hover:text-ink disabled:opacity-55">
            <RotateCcw className="size-3" aria-hidden /> New chat
          </button>
        ) : null}
      </div>
    </form>
  );
}
