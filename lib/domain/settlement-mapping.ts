// Converting a settlement file in someone else's layout into Kosha's four columns.
// Pure functions, unit tested, used in the browser (preview) and on the server (to check the
// AI's proposed mapping on sample rows). The AI only chooses *which* column and *which* format;
// this code does every conversion, so a wrong guess shows up as rows that fail to convert, never
// as silently wrong numbers.

import { toPaise } from "@/lib/money";

export const DATE_FORMATS = ["ISO", "DD/MM/YYYY", "DD-MM-YYYY", "DD.MM.YYYY", "MM/DD/YYYY", "YYYY/MM/DD", "DD-MMM-YYYY", "DD MMM YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const STATUS_TARGETS = ["SUCCESS", "FAILED", "REFUNDED", "IGNORE"] as const;
export type StatusTarget = (typeof STATUS_TARGETS)[number];

export type ColumnMapping = {
  gatewayRef: { column: string };
  amount: { column: string; unit: "rupees" | "paise" };
  /** column "" means the file has no status column: every row is a settlement. */
  status: { column: string; values: { from: string; to: StatusTarget }[] };
  settledAt: { column: string; format: DateFormat };
};

export type StandardRow = { gateway_ref: string; amount_inr: string; status: string; settled_at: string };
export type MappingIssue = { line: number; field: "gateway_ref" | "amount_inr" | "status" | "settled_at"; value: string; problem: string };
export type MappingStats = { rows: number; converted: number; byField: Record<MappingIssue["field"], number> };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TIME = String.raw`(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?`;
const ZONE = String.raw`\s*(Z|[+-]\d{2}:?\d{2}|IST)?`;

const DATE_RES: Record<Exclude<DateFormat, "ISO">, { re: RegExp; order: ("d" | "m" | "y" | "mon")[] }> = {
  "DD/MM/YYYY": { re: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME}${ZONE}$`), order: ["d", "m", "y"] },
  "DD-MM-YYYY": { re: new RegExp(String.raw`^(\d{1,2})-(\d{1,2})-(\d{4})${TIME}${ZONE}$`), order: ["d", "m", "y"] },
  "DD.MM.YYYY": { re: new RegExp(String.raw`^(\d{1,2})\.(\d{1,2})\.(\d{4})${TIME}${ZONE}$`), order: ["d", "m", "y"] },
  "MM/DD/YYYY": { re: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME}${ZONE}$`), order: ["m", "d", "y"] },
  "YYYY/MM/DD": { re: new RegExp(String.raw`^(\d{4})/(\d{1,2})/(\d{1,2})${TIME}${ZONE}$`), order: ["y", "m", "d"] },
  "DD-MMM-YYYY": { re: new RegExp(String.raw`^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})${TIME}${ZONE}$`), order: ["d", "mon", "y"] },
  "DD MMM YYYY": { re: new RegExp(String.raw`^(\d{1,2}) ([A-Za-z]{3,9}),? (\d{4})${TIME}${ZONE}$`), order: ["d", "mon", "y"] },
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A date in the given format -> ISO 8601 with offset (IST when the file gives no zone), or null. */
export function parseDateAs(value: string, format: DateFormat): string | null {
  const v = value.trim();
  if (!v) return null;
  if (format === "ISO") {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
    if (!m) return null;
    return build(+m[1]!, +m[2]!, +m[3]!, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0, m[7]);
  }
  const { re, order } = DATE_RES[format];
  const m = re.exec(v);
  if (!m) return null;
  const parts: Record<string, number> = {};
  for (let i = 0; i < 3; i++) {
    const key = order[i]!;
    const raw = m[i + 1]!;
    if (key === "mon") {
      const idx = MONTHS.indexOf(raw.slice(0, 3).toLowerCase());
      if (idx === -1) return null;
      parts.m = idx + 1;
    } else parts[key] = Number(raw);
  }
  let hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const second = m[6] ? Number(m[6]) : 0;
  const ampm = m[7]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  }
  const zone = m[8] === "IST" ? undefined : m[8];
  return build(parts.y!, parts.m!, parts.d!, hour, minute, second, zone);
}

function build(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string | undefined): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  // Reject dates that do not exist (31/02/2026).
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const off = !zone ? "+05:30" : zone === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${off}`;
}

/** Amount text -> canonical "12345.50" rupees, never through floating point. */
export function parseAmountAs(value: string, unit: "rupees" | "paise"): { ok: true; rupees: string; paise: number } | { ok: false; problem: string } {
  const cleaned = value.trim().replace(/^(₹|Rs\.?|INR)\s*/i, "").replace(/\s*(INR)$/i, "").trim();
  if (!cleaned) return { ok: false, problem: "empty" };
  if (/^-|^\(.*\)$/.test(cleaned)) return { ok: false, problem: "negative amount (a refund or reversal row?)" };
  let paise: number;
  if (unit === "paise") {
    if (!/^\d[\d,]*$/.test(cleaned)) return { ok: false, problem: "not a whole number of paise" };
    paise = Number(cleaned.replace(/,/g, ""));
    if (!Number.isSafeInteger(paise)) return { ok: false, problem: "too large" };
  } else {
    const r = toPaise(cleaned);
    if (!r.ok) return { ok: false, problem: r.error };
    paise = r.paise;
  }
  return { ok: true, paise, rupees: `${Math.floor(paise / 100)}.${pad(paise % 100)}` };
}

const REF_RE = /^[A-Z0-9_-]{4,64}$/;

export function applyMapping(rows: Record<string, string | undefined>[], mapping: ColumnMapping, firstLine = 2): { rows: StandardRow[]; issues: MappingIssue[]; stats: MappingStats } {
  const out: StandardRow[] = [];
  const issues: MappingIssue[] = [];
  const byField: MappingStats["byField"] = { gateway_ref: 0, amount_inr: 0, status: 0, settled_at: 0 };
  const statusMap = new Map(mapping.status.values.map((v) => [v.from.trim().toLowerCase(), v.to]));
  let converted = 0;
  let counted = 0;

  rows.forEach((r, i) => {
    const line = firstLine + i;
    const values = Object.values(r).map((v) => (v ?? "").trim());
    if (values.every((v) => v === "")) return;
    counted += 1;
    const cell = (c: string) => (r[c] ?? "").trim();
    const fail = (field: MappingIssue["field"], value: string, problem: string) => {
      issues.push({ line, field, value, problem });
      byField[field] += 1;
    };

    const ref = cell(mapping.gatewayRef.column).toUpperCase();
    if (!REF_RE.test(ref)) fail("gateway_ref", ref, ref ? "does not look like a gateway reference" : "empty");

    const amount = parseAmountAs(cell(mapping.amount.column), mapping.amount.unit);
    if (!amount.ok) fail("amount_inr", cell(mapping.amount.column), amount.problem);

    let status = "SUCCESS";
    if (mapping.status.column) {
      const raw = cell(mapping.status.column);
      const to = statusMap.get(raw.toLowerCase());
      if (!to) fail("status", raw, "no mapping for this status value");
      else status = to === "IGNORE" ? "CANCELLED" : to;
    }

    const date = parseDateAs(cell(mapping.settledAt.column), mapping.settledAt.format);
    if (!date) fail("settled_at", cell(mapping.settledAt.column), `not a ${mapping.settledAt.format} date`);

    // Rows that fail are still passed on (with the raw value), so reconciliation reports them
    // as invalid with their line number instead of them disappearing.
    out.push({
      gateway_ref: ref,
      amount_inr: amount.ok ? amount.rupees : cell(mapping.amount.column),
      status,
      settled_at: date ?? cell(mapping.settledAt.column),
    });
    if (issues.length === 0 || issues[issues.length - 1]!.line !== line) converted += 1;
  });

  return { rows: out, issues, stats: { rows: counted, converted, byField } };
}

const SWAPPED: Partial<Record<DateFormat, DateFormat>> = { "DD/MM/YYYY": "MM/DD/YYYY", "MM/DD/YYYY": "DD/MM/YYYY" };

/**
 * True when every date in the column reads just as well day-first as month-first (no day above
 * 12), so a wrong choice would convert without errors and give wrong dates. The UI then asks the
 * accountant to confirm the format.
 */
export function dateFormatAmbiguous(rows: Record<string, string | undefined>[], column: string, format: DateFormat): boolean {
  const other = SWAPPED[format];
  if (!other) return false;
  const values = rows.map((r) => (r[column] ?? "").trim()).filter(Boolean);
  return values.length > 0 && values.every((v) => parseDateAs(v, format) !== null && parseDateAs(v, other) !== null);
}

/** Kosha's own CSV format, ready for the normal reconciliation upload. */
export function toStandardCsv(rows: StandardRow[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["gateway_ref,amount_inr,status,settled_at", ...rows.map((r) => [r.gateway_ref, r.amount_inr, r.status, r.settled_at].map(esc).join(","))].join("\n") + "\n";
}

/** Identifies a file layout, so a confirmed mapping can be reused for the next file. */
export function headerSignature(headers: string[]): string {
  return headers.map((h) => h.trim().toLowerCase()).filter(Boolean).sort().join("|");
}

/** Which columns a mapping uses that the file does not have. */
export function unknownColumns(mapping: ColumnMapping, headers: string[]): string[] {
  const have = new Set(headers);
  return [mapping.gatewayRef.column, mapping.amount.column, mapping.status.column, mapping.settledAt.column].filter((c) => c && !have.has(c));
}

export type ColumnProfile = { column: string; examples: string[]; distinct: number; blank: number };

/** What the AI sees of each column: a few distinct example values, not the whole file. */
export function profileColumns(headers: string[], rows: Record<string, string | undefined>[], maxExamples = 6): ColumnProfile[] {
  return headers.map((h) => {
    const vals = rows.map((r) => (r[h] ?? "").trim());
    const distinct = [...new Set(vals.filter(Boolean))];
    return { column: h, examples: distinct.slice(0, maxExamples), distinct: distinct.length, blank: vals.filter((v) => !v).length };
  });
}

/**
 * Rows sent to the model (at most `max`): the first rows, then at least one row for every
 * distinct value of each low-cardinality column (so a single "Failed" row at the end of the
 * file is seen), then rows spread across the rest of the file.
 */
export function sampleRows<T extends Record<string, string | undefined>>(rows: T[], max = 25, first = 12): T[] {
  if (rows.length <= max) return rows;
  const picked = new Set<number>(Array.from({ length: first }, (_, i) => i));
  const headers = Object.keys(rows[0] ?? {});
  for (const h of headers) {
    const seen = new Map<string, number>();
    rows.forEach((r, i) => {
      const v = (r[h] ?? "").trim();
      if (!seen.has(v)) seen.set(v, i);
    });
    if (seen.size > 12) continue; // not a category-like column
    for (const i of seen.values()) if (picked.size < max) picked.add(i);
  }
  const step = rows.length / Math.max(1, max - picked.size);
  for (let k = 0; picked.size < max && k < rows.length; k++) picked.add(Math.min(rows.length - 1, Math.floor(k * step)));
  return [...picked].sort((a, b) => a - b).map((i) => rows[i]!);
}
