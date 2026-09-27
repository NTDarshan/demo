"use client";

// Draft a message to a student's parent, in English, Kannada or Hindi, from the ledger's facts.
// Staff review and edit the draft; the figure checks re-run on every edit, so a wrong amount
// typed by a person is caught as well. Kosha never sends it: staff copy it into WhatsApp or email.

import { AlertTriangle, Check, Copy, Loader2, MessageSquareText, RotateCw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import type { StudentDetail } from "@/lib/data/students";
import { isoDateIST } from "@/lib/dates";
import type { DraftResult } from "@/lib/ai/parent-message/draft";
import { buildFacts, LANGUAGE_LABEL, PURPOSE_LABEL, PURPOSES, type Channel, type Language, type Purpose } from "@/lib/ai/parent-message/facts";
import { verifyMessage } from "@/lib/ai/parent-message/verify";

export function ParentMessageButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="secondary" onClick={onClick}>
      <MessageSquareText aria-hidden />
      Message parent
    </Button>
  );
}

export function ParentMessageDrawer({ open, onOpenChange, detail }: { open: boolean; onOpenChange: (o: boolean) => void; detail: StudentDetail }) {
  const { purposes } = useMemo(() => buildFacts(detail, isoDateIST()), [detail]);
  const firstAvailable = (detail.balance.overduePaise > 0 ? "OVERDUE" : PURPOSES.find((p) => purposes[p].available)) as Purpose;
  const [purpose, setPurpose] = useState<Purpose>(firstAvailable ?? "BALANCE");
  const [language, setLanguage] = useState<Language>("en");
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [result, setResult] = useState<DraftResult | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function draft() {
    setLoading(true);
    setError(null);
    try {
      const r = await api<DraftResult>("/api/ai/parent-message", { body: { student: detail.student.rollNo, purpose, language, channel } });
      setResult(r);
      setSubject(r.subject);
      setMessage(r.message);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not draft the message. Try again.");
    } finally {
      setLoading(false);
    }
  }

  // Re-checked on every edit.
  const live = useMemo(
    () =>
      result
        ? verifyMessage(
            { subject, message, englishGist: result.englishGist },
            { amountsPaise: new Set(result.amountsPaise), keyFigurePaise: purposes[purpose].keyFigurePaise, keyFigure: result.keyFigure, language, channel },
          )
        : null,
    [result, subject, message, purposes, purpose, language, channel],
  );
  const edited = result !== null && (message !== result.message || subject !== result.subject);

  function copy() {
    const text = channel === "email" && subject ? `${subject}\n\n${message}` : message;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="max-w-[600px]"
        title="Message to parent"
        description={`${detail.student.name} · ${detail.student.rollNo}`}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">Kosha does not send messages. Copy it into WhatsApp or email.</p>
            <div className="flex gap-2">
              {result ? (
                <Button variant="secondary" onClick={() => void draft()} loading={loading}>
                  <RotateCw aria-hidden /> Draft again
                </Button>
              ) : null}
              {result ? (
                <Button onClick={copy} disabled={!message.trim()}>
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {copied ? "Copied" : "Copy message"}
                </Button>
              ) : (
                <Button onClick={() => void draft()} loading={loading} disabled={!purposes[purpose].available}>
                  {loading ? "Drafting" : "Draft message"}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          <Segmented
            name="purpose"
            label="Message"
            value={purpose}
            onChange={(v) => {
              setPurpose(v);
              setResult(null);
            }}
            options={PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABEL[p], disabled: !purposes[p].available }))}
          />
          {!purposes[purpose].available ? <p className="-mt-3 text-sm text-muted">{purposes[purpose].reason}</p> : null}
          <div className="grid gap-4 sm:grid-cols-[3fr_2fr]">
            <Segmented
              name="language"
              label="Language"
              value={language}
              onChange={(v) => {
                setLanguage(v);
                setResult(null);
              }}
              options={[
                { value: "en", label: "English" },
                { value: "kn", label: "ಕನ್ನಡ" },
                { value: "hi", label: "हिन्दी" },
              ]}
            />
            <Segmented
              name="channel"
              label="For"
              value={channel}
              onChange={(v) => {
                setChannel(v);
                setResult(null);
              }}
              options={[
                { value: "whatsapp", label: "WhatsApp" },
                { value: "email", label: "Email" },
              ]}
            />
          </div>

          {!result && !loading ? (
            <p className="rounded border border-line px-3.5 py-3 text-sm text-muted">
              The amounts, dates and receipt numbers come from {detail.student.name}&apos;s ledger. The AI writes the wording in {LANGUAGE_LABEL[language].split(" ").pop()}, and every
              amount is checked against the ledger before you see it.
            </p>
          ) : null}

          {loading ? (
            <p className="flex items-center gap-2 text-sm" aria-live="polite">
              <Loader2 className="size-4 animate-spin text-accent" aria-hidden /> Writing and checking the message
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="flex gap-2 rounded tint-debit px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="text-ink">{error}</span>
            </p>
          ) : null}

          {result && live ? (
            <>
              {channel === "email" ? (
                <div>
                  <Label htmlFor="pm-subject">Subject</Label>
                  <Input id="pm-subject" value={subject} onChange={(e) => setSubject(e.target.value)} lang={language} />
                </div>
              ) : null}
              <div>
                <Label htmlFor="pm-message">Message {edited ? <span className="font-normal text-muted">(edited)</span> : null}</Label>
                <Textarea id="pm-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={12} lang={language} className="min-h-[240px] leading-relaxed" />
              </div>

              <div className={cn("flex gap-2.5 rounded px-3.5 py-3 text-sm", live.ok ? "tint-credit" : "tint-pending")}>
                {live.ok ? <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
                <div className="text-ink">
                  <p className="font-medium">{live.ok ? "Checked against the ledger" : "Check before sending"}</p>
                  <ul className="mt-1 space-y-0.5 text-muted">
                    {live.checks.map((c) => (
                      <li key={c.name} className={cn(!c.ok && "text-ink")}>
                        {c.ok ? "✓" : "✗"} {c.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {result.englishGist ? (
                <details className="rounded-panel border border-line" open>
                  <summary className="cursor-pointer px-3.5 py-2 text-sm font-medium">What this says, in English</summary>
                  <p className="whitespace-pre-wrap border-t border-line px-3.5 py-3 text-sm text-muted">{result.englishGist}</p>
                  {edited ? <p className="border-t border-line px-3.5 py-2 text-xs text-pending">You edited the message; this English version is of the original draft.</p> : null}
                </details>
              ) : null}

              <p className="text-xs text-muted">
                Drafted in {(result.latencyMs / 1000).toFixed(1)}s · {result.attempts > 1 ? "rewritten once after a failed check · " : ""}
                {result.usage.total.toLocaleString("en-IN")} tokens · {result.model} · recorded in the audit log
              </p>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
