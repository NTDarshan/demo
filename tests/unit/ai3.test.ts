import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { verifyMessage } from "@/lib/ai/parent-message/verify";
import { reconcileCsv } from "@/lib/domain/settlement-csv";
import { applyMapping, dateFormatAmbiguous, headerSignature, parseAmountAs, parseDateAs, sampleRows, toStandardCsv, unknownColumns, type ColumnMapping } from "@/lib/domain/settlement-mapping";

describe("parseDateAs", () => {
  it("reads Indian day-first dates with 12-hour times, as IST", () => {
    expect(parseDateAs("22/09/2026 11:00 AM", "DD/MM/YYYY")).toBe("2026-09-22T11:00:00+05:30");
    expect(parseDateAs("05/10/2026 12:15 PM", "DD/MM/YYYY")).toBe("2026-10-05T12:15:00+05:30");
    expect(parseDateAs("05/10/2026 12:15 AM", "DD/MM/YYYY")).toBe("2026-10-05T00:15:00+05:30");
    expect(parseDateAs("22-Sep-2026", "DD-MMM-YYYY")).toBe("2026-09-22T00:00:00+05:30");
    expect(parseDateAs("22 September 2026 18:30", "DD MMM YYYY")).toBe("2026-09-22T18:30:00+05:30");
    expect(parseDateAs("2026-09-22T05:30:00Z", "ISO")).toBe("2026-09-22T05:30:00Z");
  });
  it("tells day-first and month-first apart, and rejects impossible dates", () => {
    expect(parseDateAs("09/10/2026", "DD/MM/YYYY")).toBe("2026-10-09T00:00:00+05:30");
    expect(parseDateAs("09/10/2026", "MM/DD/YYYY")).toBe("2026-09-10T00:00:00+05:30");
    expect(parseDateAs("22/09/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDateAs("31/02/2026", "DD/MM/YYYY")).toBeNull();
    expect(parseDateAs("13:00 PM 22/09/2026", "DD/MM/YYYY")).toBeNull();
    expect(parseDateAs("", "ISO")).toBeNull();
  });
});

describe("parseAmountAs", () => {
  it("reads rupees with Indian grouping and currency markers, without floating point", () => {
    expect(parseAmountAs("₹1,12,500.00", "rupees")).toMatchObject({ ok: true, rupees: "112500.00", paise: 11_250_000 });
    expect(parseAmountAs("Rs. 62,000", "rupees")).toMatchObject({ ok: true, rupees: "62000.00" });
    expect(parseAmountAs("60683.12 INR", "rupees")).toMatchObject({ ok: true, paise: 6_068_312 });
  });
  it("reads paise, and refuses negative (refund) rows", () => {
    expect(parseAmountAs("8650000", "paise")).toMatchObject({ ok: true, rupees: "86500.00" });
    expect(parseAmountAs("86500.00", "paise").ok).toBe(false);
    expect(parseAmountAs("-500.00", "rupees").ok).toBe(false);
    expect(parseAmountAs("(500.00)", "rupees").ok).toBe(false);
  });
});

const GATEWAY_MAPPING: ColumnMapping = {
  gatewayRef: { column: "Txn Reference" },
  amount: { column: "Gross Amount (Rs)", unit: "rupees" },
  status: { column: "Txn Status", values: [{ from: "Captured", to: "SUCCESS" }, { from: "Failed", to: "FAILED" }] },
  settledAt: { column: "Settlement Date", format: "DD/MM/YYYY" },
};

describe("applyMapping on the gateway-layout sample", () => {
  const text = readFileSync(join(__dirname, "../../public/samples/gateway_report_sep_2026.csv"), "utf8");
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: false });

  it("converts every row, and reconciles to the same buckets as the standard sample file", () => {
    const { rows, issues, stats } = applyMapping(parsed.data, GATEWAY_MAPPING);
    expect(issues).toEqual([]);
    expect(stats.converted).toBe(stats.rows);
    const standard = readFileSync(join(__dirname, "../../public/samples/settlement_sample.csv"), "utf8");
    const system = standard
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(","))
      .map(([ref, amount]) => ({ id: ref!, gatewayRef: ref!, amountPaise: Math.round(Number(amount) * 100), status: "SUCCESS" as const, paidAt: "2026-08-20T10:00:00+05:30" }));
    const a = reconcileCsv(toStandardCsv(rows), system);
    const b = reconcileCsv(standard, system);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.items.map((i) => [i.gatewayRef, i.bucket, i.fileAmountPaise, i.settledAt])).toEqual(b.items.map((i) => [i.gatewayRef, i.bucket, i.fileAmountPaise, i.settledAt]));
      // The extra failed transaction is set aside as "not a settlement".
      expect(a.rejected.map((r) => r.kind)).toEqual(["ignored"]);
    }
  });

  it("reports rows that do not convert, with line numbers, when a choice is wrong", () => {
    const wrong = { ...GATEWAY_MAPPING, settledAt: { column: "Settlement Date", format: "MM/DD/YYYY" as const } };
    const { issues, stats } = applyMapping(parsed.data, wrong);
    expect(stats.converted).toBeLessThan(stats.rows);
    // Lines 2 and 3 (10/08 and 11/08) also read as 8 Oct and 8 Nov: only days above 12 fail.
    // That is why dateFormatAmbiguous() exists.
    expect(issues[0]).toMatchObject({ field: "settled_at", line: 4 });
  });

  it("warns when day and month cannot be told apart", () => {
    expect(dateFormatAmbiguous(parsed.data, "Settlement Date", "DD/MM/YYYY")).toBe(false);
    const early = parsed.data.filter((r) => Number((r["Settlement Date"] ?? "").slice(0, 2)) <= 12);
    expect(dateFormatAmbiguous(early, "Settlement Date", "DD/MM/YYYY")).toBe(true);
    expect(dateFormatAmbiguous(early, "Settlement Date", "ISO")).toBe(false);
  });

  it("flags status values nobody mapped, and columns the file does not have", () => {
    const partial = { ...GATEWAY_MAPPING, status: { column: "Txn Status", values: [{ from: "Captured", to: "SUCCESS" as const }] } };
    expect(applyMapping(parsed.data, partial).issues.map((i) => i.value)).toEqual(["Failed"]);
    expect(unknownColumns({ ...GATEWAY_MAPPING, gatewayRef: { column: "UTR" } }, parsed.meta.fields ?? [])).toEqual(["UTR"]);
  });
});

describe("sampleRows", () => {
  it("includes a rare status value at the end of the file", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ ref: `R${i}`, status: i === 59 ? "Failed" : "Captured" }));
    const s = sampleRows(rows);
    expect(s.length).toBeLessThanOrEqual(25);
    expect(s.some((r) => r.status === "Failed")).toBe(true);
  });
  it("sends small files whole", () => {
    expect(sampleRows([{ a: "1" }, { a: "2" }])).toHaveLength(2);
  });
  it("identifies a layout regardless of column order or case", () => {
    expect(headerSignature(["B", "a "])).toBe(headerSignature(["A", "b"]));
  });
});

describe("verifyMessage", () => {
  const ctx = { amountsPaise: new Set([8_400_000, 3_800_000]), keyFigurePaise: 8_400_000, keyFigure: "₹84,000", language: "en" as const, channel: "whatsapp" as const };
  const good = { subject: "", message: "Dear Parent, fees of ₹84,000 for Sneha Iyer (BCA26-002) are overdue since 15 Aug 2026, including Tuition Term 1 ₹38,000.", englishGist: "" };

  it("passes a message that uses only ledger figures and states the key amount", () => {
    expect(verifyMessage(good, ctx).ok).toBe(true);
  });
  it("catches a wrong figure, a missing key amount and an amount written without ₹", () => {
    const v = verifyMessage({ ...good, message: "Fees of ₹48,000 are overdue. Tuition 38,000 is included." }, ctx);
    expect(v.unverifiedAmounts).toEqual(["₹48,000"]);
    const names = v.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Figures match the ledger", "Key amount included", "Amounts written as ₹ figures"]));
  });
  it("catches an assumed gender in English, Kannada and Hindi", () => {
    expect(verifyMessage({ ...good, message: `${good.message} Please remind your daughter.` }, ctx).checks.find((c) => c.name === "No assumed gender")?.ok).toBe(false);
    const kn = { ...ctx, language: "kn" as const };
    expect(verifyMessage({ ...good, message: "ನಿಮ್ಮ ಮಗಳು ₹84,000 ಬಾಕಿ", englishGist: "Your ward owes ₹84,000 in fees." }, kn).checks.find((c) => c.name === "No assumed gender")?.ok).toBe(false);
    const hi = { ...ctx, language: "hi" as const };
    expect(verifyMessage({ ...good, message: "आपके पुत्र का ₹84,000 शुल्क बाकी है", englishGist: "Your ward owes ₹84,000 in fees." }, hi).checks.find((c) => c.name === "No assumed gender")?.ok).toBe(false);
  });
  it("checks the script, native digits and the English version for Kannada", () => {
    const kn = { ...ctx, language: "kn" as const };
    expect(verifyMessage({ ...good, englishGist: "" }, kn).checks.find((c) => c.name === "Written in the chosen language")?.ok).toBe(false);
    const nativeDigits = verifyMessage({ subject: "", message: "ನಿಮ್ಮ ಮಗು ₹೮೪,೦೦೦ ಬಾಕಿ ಇದೆ", englishGist: "Your ward owes fees." }, kn);
    expect(nativeDigits.checks.find((c) => c.name === "Amounts written as ₹ figures")?.ok).toBe(false);
    const fine = verifyMessage({ subject: "", message: "ಪೋಷಕರೇ, ಸ್ನೇಹ ಅವರ ₹84,000 ಶುಲ್ಕ ಬಾಕಿ ಇದೆ. ದಯವಿಟ್ಟು ಪಾವತಿಸಿ.", englishGist: "Dear Parent, Sneha's fees of ₹84,000 are due. Please pay." }, kn);
    expect(fine.ok).toBe(true);
  });
  it("requires a subject for email and a short message for WhatsApp", () => {
    expect(verifyMessage(good, { ...ctx, channel: "email" }).checks.find((c) => c.name === "Email has a subject")?.ok).toBe(false);
    expect(verifyMessage({ ...good, message: `${good.message} ${"x".repeat(900)}` }, ctx).checks.find((c) => c.name === "Short enough for WhatsApp")?.ok).toBe(false);
  });
});
