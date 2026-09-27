"use client";

// Smart import: a settlement file in another layout. The AI proposes which column is which;
// this screen shows the proposal applied to every row of the file (the conversion itself is
// deterministic code), lets the accountant change any choice, and only then reconciles.

import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import type { MappingResult } from "@/lib/ai/settlement-mapper";
import {
  applyMapping,
  DATE_FORMATS,
  dateFormatAmbiguous,
  headerSignature,
  sampleRows,
  STATUS_TARGETS,
  toStandardCsv,
  type ColumnMapping,
  type DateFormat,
  type StatusTarget,
} from "@/lib/domain/settlement-mapping";

type Rows = Record<string, string | undefined>[];
type Saved = { mapping: ColumnMapping; savedAt: string };
export type MappingNote = {
  source: "ai" | "saved" | "edited";
  originalHeaders: string[];
  columns: { gateway_ref: string; amount_inr: string; status: string; settled_at: string };
  model: string | null;
};

const STORAGE = (sig: string) => `kosha.importMapping.${sig}`;
function loadSaved(sig: string): Saved | null {
  try {
    const raw = window.localStorage.getItem(STORAGE(sig));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(sig: string, mapping: ColumnMapping) {
  try {
    window.localStorage.setItem(STORAGE(sig), JSON.stringify({ mapping, savedAt: new Date().toISOString() } satisfies Saved));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

const TARGET_LABEL: Record<StatusTarget, string> = { SUCCESS: "Settled", FAILED: "Failed", REFUNDED: "Refunded", IGNORE: "Not a settlement" };
const FIELDS = [
  { key: "gatewayRef", label: "Gateway reference", help: "The transaction reference Kosha stored for the payment." },
  { key: "amount", label: "Amount", help: "Gross amount the parent paid, before gateway fees." },
  { key: "status", label: "Status", help: "Whether the transaction settled." },
  { key: "settledAt", label: "Settled on", help: "When the gateway paid the money to the college." },
] as const;

export function SmartImport({
  fileName,
  headers,
  rows,
  aiOn,
  onCancel,
  onConfirm,
  busy,
}: {
  fileName: string;
  headers: string[];
  rows: Rows;
  aiOn: boolean;
  onCancel: () => void;
  onConfirm: (csv: string, note: MappingNote) => void;
  busy: boolean;
}) {
  const sig = useMemo(() => headerSignature(headers), [headers]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [ai, setAi] = useState<MappingResult | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [edited, setEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);

  async function askAi() {
    setLoading(true);
    setError(null);
    try {
      const result = await api<MappingResult>("/api/ai/settlement-mapping", { body: { headers, rows: sampleRows(rows.filter((r) => Object.values(r).some((v) => (v ?? "").trim()))) } });
      setAi(result);
      setMapping(result.mapping);
      setSaved(null);
      setEdited(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not reach the import assistant. Try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const s = loadSaved(sig);
    if (s && s.mapping && headers.includes(s.mapping.gatewayRef.column)) {
      setSaved(s);
      setMapping(s.mapping);
    } else if (aiOn) void askAi();
    // Once per file layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Every distinct status value in the whole file, so none is left unmapped.
  const statusValues = useMemo(() => {
    if (!mapping?.status.column) return [];
    const col = mapping.status.column;
    return [...new Set(rows.map((r) => (r[col] ?? "").trim()).filter(Boolean))].slice(0, 30);
  }, [mapping?.status.column, rows]);

  const applied = useMemo(() => (mapping ? applyMapping(rows, mapping) : null), [mapping, rows]);
  const ambiguous = useMemo(() => (mapping ? dateFormatAmbiguous(rows, mapping.settledAt.column, mapping.settledAt.format) : false), [mapping, rows]);
  const [ambiguityOk, setAmbiguityOk] = useState(false);

  function update(fn: (m: ColumnMapping) => ColumnMapping) {
    setMapping((m) => (m ? fn(m) : m));
    setEdited(true);
  }

  function confirm() {
    if (!mapping || !applied) return;
    if (remember) save(sig, mapping);
    const statusText = mapping.status.column
      ? `${mapping.status.column}: ${mapping.status.values.map((v) => `${v.from} → ${v.to}`).join(", ")}`
      : "none (every row treated as settled)";
    onConfirm(toStandardCsv(applied.rows), {
      source: edited ? "edited" : saved ? "saved" : "ai",
      originalHeaders: headers.slice(0, 40),
      columns: {
        gateway_ref: mapping.gatewayRef.column,
        amount_inr: `${mapping.amount.column} (${mapping.amount.unit})`,
        status: statusText.slice(0, 160),
        settled_at: `${mapping.settledAt.column} (${mapping.settledAt.format})`,
      },
      model: ai?.model ?? null,
    });
  }

  const unmappedStatus = mapping?.status.column ? statusValues.filter((v) => !mapping.status.values.some((x) => x.from.toLowerCase() === v.toLowerCase())) : [];

  return (
    <div className="space-y-4 rounded-panel border border-accent/25 bg-accent/5 p-4 sm:p-5">
      <div className="flex gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">
            <span className="break-all">{fileName}</span> uses a different layout
          </p>
          <p className="text-sm text-muted">
            Kosha needs a gateway reference, amount, status and settlement date for each row.{" "}
            {saved
              ? `Using the mapping you confirmed on ${formatDateTime(saved.savedAt)} for files with these columns.`
              : "The import assistant matched them to this file's columns. Check each one before reconciling."}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm" aria-live="polite">
          <Loader2 className="size-4 animate-spin text-accent" aria-hidden /> Reading the columns and {Math.min(rows.length, 25)} sample rows
        </p>
      ) : null}

      {!aiOn && !mapping ? (
        <p className="text-sm">
          The import assistant is off (no OpenAI key on the server). Rename the columns to <span className="font-mono">gateway_ref, amount_inr, status, settled_at</span> and upload again.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="flex gap-2 rounded tint-debit px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="text-ink">{error}</span>
        </p>
      ) : null}

      {mapping && applied ? (
        <>
          <div className="overflow-hidden rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th scope="col" className="px-3 py-2 font-medium">Kosha needs</th>
                  <th scope="col" className="px-3 py-2 font-medium">From this column</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Why</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => {
                  const column = mapping[f.key].column;
                  const reason = ai && !edited ? ai.reasons[f.key] : null;
                  return (
                    <tr key={f.key} className="border-b border-line align-top last:border-0">
                      <td className="px-3 py-2.5">
                        <p className="font-medium">{f.label}</p>
                        <p className="text-xs text-muted">{f.help}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-2">
                          <select
                            aria-label={`${f.label} column`}
                            value={column}
                            onChange={(e) => update((m) => ({ ...m, [f.key]: { ...m[f.key], column: e.target.value } }))}
                            className="select-chevron h-8 min-w-0 max-w-[220px] rounded border border-line-strong bg-surface pl-2 pr-7 text-sm"
                          >
                            {f.key === "status" ? <option value="">No status column (all settled)</option> : null}
                            {headers.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                          {f.key === "amount" ? (
                            <select
                              aria-label="Amount unit"
                              value={mapping.amount.unit}
                              onChange={(e) => update((m) => ({ ...m, amount: { ...m.amount, unit: e.target.value as "rupees" | "paise" } }))}
                              className="select-chevron h-8 rounded border border-line-strong bg-surface pl-2 pr-7 text-sm"
                            >
                              <option value="rupees">in rupees</option>
                              <option value="paise">in paise</option>
                            </select>
                          ) : null}
                          {f.key === "settledAt" ? (
                            <select
                              aria-label="Date format"
                              value={mapping.settledAt.format}
                              onChange={(e) => update((m) => ({ ...m, settledAt: { ...m.settledAt, format: e.target.value as DateFormat } }))}
                              className="select-chevron h-8 rounded border border-line-strong bg-surface pl-2 pr-7 text-sm"
                            >
                              {DATE_FORMATS.map((d) => (
                                <option key={d} value={d}>
                                  {d === "ISO" ? "ISO (2026-09-22)" : d}
                                </option>
                              ))}
                            </select>
                          ) : null}
                        </div>
                        {f.key === "status" && mapping.status.column ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {statusValues.map((v) => {
                              const to = mapping.status.values.find((x) => x.from.toLowerCase() === v.toLowerCase())?.to ?? "";
                              return (
                                <label key={v} className={cn("inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs", to ? "border-line" : "border-pending tint-pending")}>
                                  <span className="font-medium">{v}</span>→
                                  <select
                                    aria-label={`Status ${v} means`}
                                    value={to}
                                    onChange={(e) =>
                                      update((m) => ({
                                        ...m,
                                        status: { ...m.status, values: [...m.status.values.filter((x) => x.from.toLowerCase() !== v.toLowerCase()), { from: v, to: e.target.value as StatusTarget }] },
                                      }))
                                    }
                                    className="bg-transparent text-xs"
                                  >
                                    {!to ? <option value="">Choose</option> : null}
                                    {STATUS_TARGETS.map((t) => (
                                      <option key={t} value={t}>
                                        {TARGET_LABEL[t]}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              );
                            })}
                          </div>
                        ) : null}
                        <p className="mt-1 text-xs text-muted">
                          e.g. {rows.slice(0, 2).map((r) => (r[column] ?? "").trim() || "–").join(", ")}
                        </p>
                      </td>
                      <td className="hidden px-3 py-2.5 text-xs text-muted md:table-cell">{reason ?? (edited ? "Changed by you." : saved ? "Saved mapping." : "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {ai?.notes.length && !edited ? (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted">
              {ai.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}

          <div className={cn("flex gap-2.5 rounded px-3.5 py-2.5 text-sm", applied.issues.length || unmappedStatus.length ? "tint-pending" : "tint-credit")}>
            {applied.issues.length || unmappedStatus.length ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <div className="text-ink">
              <p className="font-medium">
                {applied.stats.converted} of {applied.stats.rows} rows convert cleanly
              </p>
              {unmappedStatus.length ? <p>Choose what these status values mean: {unmappedStatus.join(", ")}.</p> : null}
              {applied.issues.length ? (
                <ul className="mt-1 space-y-0.5 text-muted">
                  {applied.issues.slice(0, 4).map((i, k) => (
                    <li key={k}>
                      Line {i.line}, {i.field}: {i.value ? `"${i.value}" ` : ""}
                      {i.problem}
                    </li>
                  ))}
                  {applied.issues.length > 4 ? <li>and {applied.issues.length - 4} more. Rows that do not convert are set aside by reconciliation, with their line number.</li> : null}
                </ul>
              ) : null}
            </div>
          </div>

          {ambiguous ? (
            <label className="flex gap-2.5 rounded tint-pending px-3.5 py-2.5 text-sm text-ink">
              <input type="checkbox" checked={ambiguityOk} onChange={(e) => setAmbiguityOk(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
              <span>
                No date in this file has a day above 12, so {mapping.settledAt.format} and its day/month swap both read every row without errors, with different
                dates. I have checked that the dates are {mapping.settledAt.format}.
              </span>
            </label>
          ) : null}

          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <p className="border-b border-line px-3 py-2 text-xs font-medium text-muted">What Kosha will reconcile (first 4 rows)</p>
            <table className="w-full min-w-[520px] font-mono text-xs">
              <thead>
                <tr className="text-left text-muted">
                  {["gateway_ref", "amount_inr", "status", "settled_at"].map((h) => (
                    <th key={h} scope="col" className="px-3 py-1.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {applied.rows.slice(0, 4).map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-1.5">{r.gateway_ref}</td>
                    <td className="px-3 py-1.5">{r.amount_inr}</td>
                    <td className="px-3 py-1.5">{r.status}</td>
                    <td className="px-3 py-1.5">{r.settled_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-[rgb(var(--accent-rgb))]" />
              Remember this mapping for files with the same columns
            </label>
            <div className="flex gap-2">
              {aiOn && (saved || edited) ? (
                <Button variant="ghost" onClick={() => void askAi()} disabled={loading || busy}>
                  <Sparkles aria-hidden /> Ask the assistant again
                </Button>
              ) : null}
              <Button variant="secondary" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={confirm} loading={busy} disabled={unmappedStatus.length > 0 || loading || (ambiguous && !ambiguityOk)}>
                {busy ? "Reconciling" : `Reconcile ${applied.stats.rows} rows`}
              </Button>
            </div>
          </div>
          {ai && !saved ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <StatusBadge tone={ai.confidence === "high" ? "credit" : ai.confidence === "medium" ? "pending" : "debit"} className="h-[18px] px-1.5">
                {ai.confidence} confidence
              </StatusBadge>
              Sent to OpenAI: the column names and {Math.min(rows.length, 25)} sample rows, not the whole file · {(ai.latencyMs / 1000).toFixed(1)}s · {ai.model}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
