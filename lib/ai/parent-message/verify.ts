// Checks on a drafted message to a parent. Pure: used on the server after drafting and in the
// browser while staff edit the draft, so a figure typed wrongly by a person is flagged too.

import { extractRupeeAmounts, type Check } from "@/lib/ai/recon-copilot/verify";
import type { Channel, Language } from "@/lib/ai/parent-message/facts";

const SCRIPT: Record<Exclude<Language, "en">, { re: RegExp; name: string }> = {
  kn: { re: /[ಀ-೿]/g, name: "Kannada" },
  hi: { re: /[ऀ-ॿ]/g, name: "Devanagari (Hindi)" },
};

export const WHATSAPP_MAX = 900;

export type MessageVerification = { ok: boolean; checks: Check[]; unverifiedAmounts: string[]; verifiedAmounts: string[] };

export function verifyMessage(
  draft: { subject: string; message: string; englishGist: string },
  ctx: { amountsPaise: ReadonlySet<number>; keyFigurePaise: number | null; keyFigure: string | null; language: Language; channel: Channel },
): MessageVerification {
  const all = [draft.subject, draft.message, draft.englishGist].join("\n");
  const found = extractRupeeAmounts(all);
  const unverified = [...new Set(found.filter((a) => !ctx.amountsPaise.has(a.paise)).map((a) => a.raw))];
  const verified = [...new Set(found.filter((a) => ctx.amountsPaise.has(a.paise)).map((a) => a.raw))];
  const checks: Check[] = [
    {
      name: "Figures match the ledger",
      ok: unverified.length === 0,
      detail: unverified.length ? `Not in the student's ledger: ${unverified.join(", ")}.` : found.length ? `All ${found.length} amounts are from the ledger.` : "No amounts in the message.",
    },
  ];

  // An amount written without ₹ ("84,000 रुपये") or in Kannada/Devanagari digits would slip
  // past the figure check, so it is not allowed.
  const bare = [...all.matchAll(/(^|[^₹\d,.\s]|\s)(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?)(?!\d)/g)]
    .filter((m) => !/(₹|Rs\.?|INR)\s?$/i.test(all.slice(Math.max(0, (m.index ?? 0) - 5), (m.index ?? 0) + m[1]!.length)))
    .map((m) => m[2]!);
  const nativeDigits = /[೦-೯०-९]/.test(all);
  checks.push({
    name: "Amounts written as ₹ figures",
    ok: bare.length === 0 && !nativeDigits,
    detail: nativeDigits ? "Amounts must use 0-9 digits so they can be checked." : bare.length ? `Write these with ₹ so they can be checked: ${[...new Set(bare)].join(", ")}.` : "Every amount is written with ₹.",
  });

  // The ledger does not record gender, so the message must not assume one.
  const gendered = all.match(/\b(son|daughter|he|she|him|his|her|hers)\b|ಮಗಳು|ಮಗನ|ಮಗನು|\sಮಗ\s|पुत्री|पुत्र|बेटी|बेटा|बेटे/gi) ?? [];
  checks.push({
    name: "No assumed gender",
    ok: gendered.length === 0,
    detail: gendered.length ? `The ledger does not record gender; remove: ${[...new Set(gendered.map((g) => g.trim().toLowerCase()))].join(", ")}.` : "Refers to the student by name or as your ward.",
  });

  if (ctx.keyFigurePaise !== null) {
    const present = extractRupeeAmounts(draft.message).some((a) => a.paise === ctx.keyFigurePaise);
    checks.push({ name: "Key amount included", ok: present, detail: present ? `${ctx.keyFigure} is in the message.` : `The message should state ${ctx.keyFigure}.` });
  }

  if (ctx.language !== "en") {
    const s = SCRIPT[ctx.language];
    const letters = draft.message.replace(/[\s\d₹.,:;!?()"'/-]/g, "");
    const inScript = (draft.message.match(s.re) ?? []).length;
    const share = letters.length ? inScript / letters.length : 0;
    checks.push({ name: "Written in the chosen language", ok: share >= 0.5, detail: share >= 0.5 ? `Written in ${s.name} script.` : `Most of the message is not in ${s.name} script.` });
    checks.push({ name: "English version provided", ok: draft.englishGist.trim().length > 20, detail: draft.englishGist.trim().length > 20 ? "An English version is included for checking." : "No English version to check against." });
  }

  if (ctx.channel === "whatsapp") {
    const ok = draft.message.length <= WHATSAPP_MAX;
    checks.push({ name: "Short enough for WhatsApp", ok, detail: ok ? `${draft.message.length} characters.` : `${draft.message.length} characters; keep it under ${WHATSAPP_MAX}.` });
  } else {
    const ok = draft.subject.trim().length > 0;
    checks.push({ name: "Email has a subject", ok, detail: ok ? "Subject line included." : "Add a subject line." });
  }

  return { ok: checks.every((c) => c.ok), checks, unverifiedAmounts: unverified, verifiedAmounts: verified };
}
